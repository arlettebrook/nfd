// @ts-nocheck
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 处理不同路径
    if (url.pathname === env.WEBHOOK_PATH) {
      return handleWebhook(request, env, ctx);
    } else if (url.pathname === "/registerWebhook") {
      return registerWebhook(request, env);
    } else if (url.pathname === "/unRegisterWebhook") {
      return unRegisterWebhook(request, env);
    }

    return new Response("No handler for this request");
  },
};

// ==================== Telegram 相关函数 ====================

function apiUrl(env, methodName, params = null) {
  let query = params ? "?" + new URLSearchParams(params).toString() : "";
  return `https://api.telegram.org/bot${env.BOT_TOKEN}/${methodName}${query}`;
}

function makeReqBody(body) {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function requestTelegram(env, methodName, body, params = null) {
  return fetch(apiUrl(env, methodName, params), body).then((r) => r.json());
}

function sendMessage(env, msg = {}) {
  return requestTelegram(env, "sendMessage", makeReqBody(msg));
}

function copyMessage(env, msg = {}) {
  return requestTelegram(env, "copyMessage", makeReqBody(msg));
}

function forwardMessage(env, msg) {
  return requestTelegram(env, "forwardMessage", makeReqBody(msg));
}

// ==================== Webhook 处理 ====================

async function handleWebhook(request, env, ctx) {
  // 校验 Secret
  if (
    request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.BOT_SECRET
  ) {
    return new Response("Unauthorized", { status: 403 });
  }

  const update = await request.json();
  ctx.waitUntil(onUpdate(env, update));
  return new Response("Ok");
}

async function onUpdate(env, update) {
  if ("message" in update) {
    await onMessage(env, update.message);
  }
}

// ==================== 消息逻辑 ====================

async function onMessage(env, message) {
  const ADMIN_UID = env.ADMIN_UID;
  const chatId = message.chat.id.toString();
  const nfd = env.nfd;

  // 人机验证
  if (message.text === "/start") {
    const verified = await nfd.get(`verified-${chatId}`, { type: "json" });
    if (verified) {
      const startMsg = await fetch(env.START_MSG_URL).then((r) => r.text());
      return sendMessage(env, { chat_id: chatId, text: startMsg });
    }

    // 生成验证码
    const code = Math.random().toString(36).substring(2, 8).toUpperCase();
    await nfd.put(`captcha-${chatId}`, code, { expirationTtl: 300 }); // 5分钟有效
    await sendMessage(env, {
      chat_id: chatId,
      text: `🤖 为确保你不是机器人，请输入以下验证码完成验证：\n\n👉 <b>${code}</b>\n\n(5分钟内有效)`,
      parse_mode: "HTML",
    });
    return;
  }

  // 检查验证码输入
  const captcha = await nfd.get(`captcha-${chatId}`, { type: "text" });
  if (captcha && message.text?.trim()?.toUpperCase() === captcha) {
    await nfd.put(`verified-${chatId}`, true, { expirationTtl: 86400 }); // 24小时有效
    await nfd.delete(`captcha-${chatId}`);
    return sendMessage(env, {
      chat_id: chatId,
      text: "✅ 验证成功！你现在可以与机器人互动了。",
    });
  } else if (captcha) {
    return sendMessage(env, {
      chat_id: chatId,
      text: "❌ 验证码错误，请重新输入。",
    });
  }

  // 若用户未验证，拒绝访问
  const verified = await nfd.get(`verified-${chatId}`, { type: "json" });
  if (!verified) {
    return sendMessage(env, {
      chat_id: chatId,
      text: "请先输入 /start 并通过人机验证。",
    });
  }

  // 管理员逻辑
  if (chatId === ADMIN_UID) {
    return handleAdminMessage(env, message);
  }

  // 普通用户逻辑
  return handleGuestMessage(env, message);
}

// ==================== 管理员逻辑 ====================

async function handleAdminMessage(env, message) {
  const ADMIN_UID = env.ADMIN_UID;
  const nfd = env.nfd;

  if (message.text === "/block") return handleBlock(env, message);
  if (message.text === "/unblock") return handleUnBlock(env, message);
  if (message.text === "/checkblock") return checkBlock(env, message);

  if (!message?.reply_to_message?.chat) {
    return sendMessage(env, {
      chat_id: ADMIN_UID,
      text: "使用方法：回复转发的消息，并发送回复消息，或使用 /block /unblock /checkblock",
    });
  }

  const guestChatId = await nfd.get(
    "msg-map-" + message.reply_to_message.message_id,
    { type: "json" }
  );

  return copyMessage(env, {
    chat_id: guestChatId,
    from_chat_id: message.chat.id,
    message_id: message.message_id,
  });
}

// ==================== 普通用户消息 ====================

async function handleGuestMessage(env, message) {
  const nfd = env.nfd;
  const ADMIN_UID = env.ADMIN_UID;
  const chatId = message.chat.id.toString();

  const isBlocked = await nfd.get("isblocked-" + chatId, { type: "json" });
  if (isBlocked) {
    return sendMessage(env, { chat_id: chatId, text: "You are blocked." });
  }

  const forwardReq = await forwardMessage(env, {
    chat_id: ADMIN_UID,
    from_chat_id: message.chat.id,
    message_id: message.message_id,
  });

  if (forwardReq.ok) {
    await nfd.put("msg-map-" + forwardReq.result.message_id, chatId);
  }

  return handleNotify(env, message);
}

// ==================== 通知逻辑 ====================

async function handleNotify(env, message) {
  const nfd = env.nfd;
  const ADMIN_UID = env.ADMIN_UID;
  const chatId = message.chat.id.toString();

  if (await isFraud(env, chatId)) {
    return sendMessage(env, {
      chat_id: ADMIN_UID,
      text: `检测到骗子，UID ${chatId}`,
    });
  }

  if (env.ENABLE_NOTIFICATION === "true") {
    const lastMsgTime = await nfd.get("lastmsg-" + chatId, { type: "json" });
    const now = Date.now();
    const interval = parseInt(env.NOTIFY_INTERVAL || "3600000", 10);

    if (!lastMsgTime || now - lastMsgTime > interval) {
      await nfd.put("lastmsg-" + chatId, now);
      const notifyText = await fetch(env.NOTIFICATION_URL).then((r) =>
        r.text()
      );
      return sendMessage(env, { chat_id: ADMIN_UID, text: notifyText });
    }
  }
}

// ==================== Block/Unblock ====================

async function handleBlock(env, message) {
  const ADMIN_UID = env.ADMIN_UID;
  const nfd = env.nfd;

  const guestChatId = await nfd.get(
    "msg-map-" + message.reply_to_message.message_id,
    { type: "json" }
  );

  if (guestChatId === ADMIN_UID) {
    return sendMessage(env, { chat_id: ADMIN_UID, text: "不能屏蔽自己" });
  }

  await nfd.put("isblocked-" + guestChatId, true);
  return sendMessage(env, {
    chat_id: ADMIN_UID,
    text: `UID:${guestChatId} 屏蔽成功`,
  });
}

async function handleUnBlock(env, message) {
  const ADMIN_UID = env.ADMIN_UID;
  const nfd = env.nfd;

  const guestChatId = await nfd.get(
    "msg-map-" + message.reply_to_message.message_id,
    { type: "json" }
  );

  await nfd.put("isblocked-" + guestChatId, false);
  return sendMessage(env, {
    chat_id: ADMIN_UID,
    text: `UID:${guestChatId} 解除屏蔽成功`,
  });
}

async function checkBlock(env, message) {
  const ADMIN_UID = env.ADMIN_UID;
  const nfd = env.nfd;

  const guestChatId = await nfd.get(
    "msg-map-" + message.reply_to_message.message_id,
    { type: "json" }
  );
  const blocked = await nfd.get("isblocked-" + guestChatId, { type: "json" });

  return sendMessage(env, {
    chat_id: ADMIN_UID,
    text: `UID:${guestChatId}` + (blocked ? " 被屏蔽" : " 没有被屏蔽"),
  });
}

// ==================== Webhook 注册 ====================

async function registerWebhook(request, env) {
  const url = new URL(request.url);
  const webhookUrl = `${url.protocol}//${url.hostname}${env.WEBHOOK_PATH}`;
  const r = await fetch(
    apiUrl(env, "setWebhook", {
      url: webhookUrl,
      secret_token: env.BOT_SECRET,
    })
  ).then((r) => r.json());

  return new Response(r.ok ? "Ok" : JSON.stringify(r, null, 2));
}

async function unRegisterWebhook(request, env) {
  const r = await fetch(apiUrl(env, "setWebhook", { url: "" })).then((r) =>
    r.json()
  );
  return new Response(r.ok ? "Ok" : JSON.stringify(r, null, 2));
}

// ==================== 骗子检测 ====================

async function isFraud(env, id) {
  const db = await fetch(env.FRAUD_DB_URL).then((r) => r.text());
  const arr = db.split("\n").filter(Boolean);
  return arr.includes(id.toString());
}