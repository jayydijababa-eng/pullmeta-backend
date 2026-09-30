"use client";

import React, { useState } from "react";

export default function BackendStatusPage() {
  const [testUrl, setTestUrl] = useState("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  const [extractOutput, setExtractOutput] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const runTestExtract = async () => {
    setLoading(true);
    setExtractOutput(null);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: testUrl }),
      });
      const data = await res.json();
      setExtractOutput(JSON.stringify(data, null, 2));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Request failed";
      setExtractOutput(JSON.stringify({ error: msg }, null, 2));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        maxWidth: "860px",
        margin: "0 auto",
        padding: "48px 24px",
      }}
    >
      {/* Header Badge */}
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          padding: "6px 12px",
          backgroundColor: "#201F1A",
          border: "1px solid #33312B",
          borderRadius: "4px",
          fontSize: "12px",
          marginBottom: "24px",
        }}
      >
        <span
          style={{
            width: "8px",
            height: "8px",
            backgroundColor: "#22c55e",
            borderRadius: "50%",
            display: "inline-block",
            boxShadow: "0 0 8px #22c55e",
          }}
        />
        <span style={{ color: "#D9D4C7" }}>PullMeta Backend Service — Active</span>
      </div>

      <h1
        style={{
          fontSize: "32px",
          fontWeight: 700,
          margin: "0 0 12px 0",
          letterSpacing: "-0.02em",
          color: "#F3F0E8",
        }}
      >
        PullMeta API Backend
      </h1>
      <p
        style={{
          fontSize: "14px",
          color: "#8E8A7E",
          lineHeight: "1.6",
          margin: "0 0 36px 0",
        }}
      >
        This is the dedicated API service for PullMeta. It provides YouTube metadata extraction,
        in-memory LRU caching, IP sliding-window rate limiting, and thumbnail streaming proxies.
      </p>

      {/* Endpoints List */}
      <div style={{ display: "flex", flexDirection: "column", gap: "16px", marginBottom: "40px" }}>
        {/* Endpoint 1: Health */}
        <div
          style={{
            padding: "16px 20px",
            backgroundColor: "#1C1B15",
            border: "1px solid #2E2C25",
            borderRadius: "6px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
              <span
                style={{
                  backgroundColor: "#22c55e22",
                  color: "#22c55e",
                  fontSize: "11px",
                  fontWeight: 700,
                  padding: "2px 6px",
                  borderRadius: "3px",
                }}
              >
                GET
              </span>
              <strong style={{ fontSize: "14px", color: "#F3F0E8" }}>/api/health</strong>
            </div>
            <span style={{ fontSize: "12px", color: "#8E8A7E" }}>
              Health status probe (returns <code>{`{"ok": true}`}</code>)
            </span>
          </div>
          <a
            href="/api/health"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "6px 14px",
              backgroundColor: "#C8401A",
              color: "#F3F0E8",
              fontSize: "12px",
              textDecoration: "none",
              borderRadius: "4px",
              fontWeight: 600,
            }}
          >
            Test Health Check &rarr;
          </a>
        </div>

        {/* Endpoint 2: Thumbnail */}
        <div
          style={{
            padding: "16px 20px",
            backgroundColor: "#1C1B15",
            border: "1px solid #2E2C25",
            borderRadius: "6px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: "12px",
          }}
        >
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
              <span
                style={{
                  backgroundColor: "#38bdf822",
                  color: "#38bdf8",
                  fontSize: "11px",
                  fontWeight: 700,
                  padding: "2px 6px",
                  borderRadius: "3px",
                }}
              >
                GET
              </span>
              <strong style={{ fontSize: "14px", color: "#F3F0E8" }}>/api/thumbnail</strong>
            </div>
            <span style={{ fontSize: "12px", color: "#8E8A7E" }}>
              Streams YouTube thumbnail as attachment (<code>?id=VIDEO_ID&amp;quality=best</code>)
            </span>
          </div>
          <a
            href="/api/thumbnail?id=dQw4w9WgXcQ&quality=best"
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "6px 14px",
              backgroundColor: "#2E2C25",
              color: "#F3F0E8",
              fontSize: "12px",
              textDecoration: "none",
              borderRadius: "4px",
              fontWeight: 600,
              border: "1px solid #444038",
            }}
          >
            Test Thumbnail Stream &rarr;
          </a>
        </div>

        {/* Endpoint 3: Extract */}
        <div
          style={{
            padding: "16px 20px",
            backgroundColor: "#1C1B15",
            border: "1px solid #2E2C25",
            borderRadius: "6px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "4px" }}>
            <span
              style={{
                backgroundColor: "#f59e0b22",
                color: "#f59e0b",
                fontSize: "11px",
                fontWeight: 700,
                padding: "2px 6px",
                borderRadius: "3px",
              }}
            >
              POST
            </span>
            <strong style={{ fontSize: "14px", color: "#F3F0E8" }}>/api/extract</strong>
          </div>
          <p style={{ fontSize: "12px", color: "#8E8A7E", margin: "4px 0 16px 0" }}>
            Extracts full video metadata, titles, descriptions, tags, and thumbnail resolutions.
          </p>

          {/* Interactive Tester */}
          <div style={{ display: "flex", gap: "8px", marginBottom: "12px" }}>
            <input
              type="text"
              value={testUrl}
              onChange={(e) => setTestUrl(e.target.value)}
              placeholder="Enter YouTube URL..."
              style={{
                flex: 1,
                padding: "8px 12px",
                backgroundColor: "#16150F",
                border: "1px solid #33312B",
                color: "#F3F0E8",
                borderRadius: "4px",
                fontSize: "12px",
                fontFamily: "inherit",
              }}
            />
            <button
              onClick={runTestExtract}
              disabled={loading}
              style={{
                padding: "8px 16px",
                backgroundColor: "#C8401A",
                color: "#F3F0E8",
                border: "none",
                borderRadius: "4px",
                cursor: loading ? "wait" : "pointer",
                fontSize: "12px",
                fontWeight: 600,
                fontFamily: "inherit",
              }}
            >
              {loading ? "Extracting..." : "Send Request"}
            </button>
          </div>

          {extractOutput && (
            <pre
              style={{
                backgroundColor: "#12110C",
                padding: "12px",
                borderRadius: "4px",
                border: "1px solid #26241E",
                fontSize: "11px",
                color: "#22c55e",
                overflowX: "auto",
                maxHeight: "260px",
                margin: 0,
              }}
            >
              {extractOutput}
            </pre>
          )}
        </div>
      </div>

      <div
        style={{
          borderTop: "1px solid #26241E",
          paddingTop: "20px",
          display: "flex",
          justifyContent: "space-between",
          fontSize: "11px",
          color: "#6B675C",
        }}
      >
        <span>PullMeta Backend v1.0.0</span>
        <span>Not affiliated with YouTube or Google LLC</span>
      </div>
    </div>
  );
}
