export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkServerBinariesStartup, autoUpdateYtDlp } = await import("@/lib/binaries");
    await checkServerBinariesStartup().catch((err) => {
      console.error("[Startup Check Error]", err);
    });

    // Fire-and-forget: keep yt-dlp current with YouTube changes
    autoUpdateYtDlp().catch((err) => console.warn("[yt-dlp Update Error]", err));

    const { getJsRuntimeArgs } = await import("@/lib/ytdlp");
    const jsArgs = getJsRuntimeArgs();
    console.log(
      `[Startup Check] yt-dlp JS runtimes: ${jsArgs.filter((_, i) => i % 2 === 1).join(", ") || "NONE (downloads will fail)"}`
    );

    const { initServerCookiesStartup } = await import("@/lib/cookies");
    await initServerCookiesStartup().catch((err) => {
      console.error("[Startup Cookie Error]", err);
    });
  }
}
