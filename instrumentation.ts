export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkServerBinariesStartup } = await import("@/lib/binaries");
    await checkServerBinariesStartup().catch((err) => {
      console.error("[Startup Check Error]", err);
    });
  }
}
