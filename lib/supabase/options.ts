// Cookies are host-scoped, not port-scoped. Keep this app independent even
// when all three Caption Arena apps run on localhost at different ports.
export const authCookieOptions = {
  name: "caption-arena-prompt-chains-auth",
};
