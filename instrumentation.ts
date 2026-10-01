export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkServerBinariesStartup } = await import("@/lib/binaries");
    await checkServerBinariesStartup().catch((err) => {
      console.error("[Startup Check Error]", err);
    });

    const { initServerCookiesStartup } = await import("@/lib/cookies");
    await initServerCookiesStartup().catch((err) => {
      console.error("[Startup Cookie Error]", err);
    });
  }
}
