/** 同时保留中文原消息与英文界面消息，避免改变既有校验接口。 */
export function domainError(message, messageEn) {
  const error = new Error(message);
  error.messageEn = messageEn;
  return error;
}
