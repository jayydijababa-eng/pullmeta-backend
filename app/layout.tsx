import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "PullMeta Backend API",
  description: "PullMeta YouTube Metadata & Thumbnail Extraction API Service",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          padding: 0,
          backgroundColor: "#16150F",
          color: "#F3F0E8",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          WebkitFontSmoothing: "antialiased",
        }}
      >
        {children}
      </body>
    </html>
  );
}
