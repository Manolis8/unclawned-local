export function isDiscordSurface(params) {
    return resolveCommandSurfaceChannel(params) === "discord";
}
export function isTelegramSurface(params) {
    return resolveCommandSurfaceChannel(params) === "telegram";
}
export function resolveCommandSurfaceChannel(params) {
    const channel = params.ctx.OriginatingChannel ??
        params.command.channel ??
        params.ctx.Surface ??
        params.ctx.Provider;
    return String(channel ?? "")
        .trim()
        .toLowerCase();
}
export function resolveDiscordAccountId(params) {
    return resolveChannelAccountId(params);
}
export function resolveChannelAccountId(params) {
    const accountId = typeof params.ctx.AccountId === "string" ? params.ctx.AccountId.trim() : "";
    return accountId || "default";
}
