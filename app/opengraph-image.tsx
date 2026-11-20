import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

export const alt = `${SITE.name} — ${SITE.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Social card: headline top-left; the shot (file → dotted arc → hoop) runs in the
 * lower band. The arc is y(t) = 447.8t² − 567.8t + 520, peaking at y≈340, so it
 * always stays below the text block (which ends near y≈330).
 */
export default function OpengraphImage() {
  const fileX = 190;
  const rimX = 935;
  const dots = Array.from({ length: 14 }, (_, i) => {
    const t = (i + 1) / 15;
    return { x: fileX + t * (rimX - fileX), y: 447.8 * t * t - 567.8 * t + 520, o: 0.35 + 0.65 * t };
  });
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#eef0f3", fontFamily: "sans-serif", position: "relative" }}>
        <div style={{ position: "absolute", left: 80, top: 64, display: "flex", flexDirection: "column", width: 640 }}>
          <div style={{ fontSize: 28, color: "#a63a10", fontWeight: 700, letterSpacing: 2 }}>{SITE.name.toUpperCase()}</div>
          <div style={{ fontSize: 64, fontWeight: 800, color: "#111318", lineHeight: 1.05, marginTop: 12 }}>Upload files by shooting hoops</div>
          <div style={{ fontSize: 28, color: "#4b5260", marginTop: 18 }}>Chunked · resumable · deduplicated</div>
        </div>

        <div style={{ position: "absolute", right: 95, top: 240, width: 330, height: 170, background: "#fff", borderRadius: 22, border: "3px dashed #d4d8df", display: "flex" }} />
        <div style={{ position: "absolute", right: 195, top: 300, width: 130, height: 92, border: "6px solid #e8622c", borderRadius: 6, background: "rgba(255,255,255,0.7)", display: "flex" }} />
        <div style={{ position: "absolute", left: rimX - 90, top: 389, width: 180, height: 22, border: "7px solid #e8622c", borderRadius: 999, display: "flex" }} />
        <div style={{ position: "absolute", left: rimX - 64, top: 410, width: 128, height: 100, borderLeft: "3px solid #9aa1ad", borderRight: "3px solid #9aa1ad", borderBottom: "3px solid #9aa1ad", borderRadius: "0 0 40px 40px", display: "flex" }} />

        {dots.map((d, i) => (
          <div key={i} style={{ position: "absolute", left: d.x - 6, top: d.y - 6, width: 12, height: 12, borderRadius: 6, background: "#e8553c", opacity: d.o, display: "flex" }} />
        ))}

        <div style={{ position: "absolute", left: fileX - 48, top: 470, width: 96, height: 118, background: "#fff", border: "3px solid #d6d9df", borderRadius: 10, display: "flex", alignItems: "flex-end", padding: 12, transform: "rotate(-14deg)" }}>
          <div style={{ background: "#e5383b", color: "#fff", fontSize: 20, fontWeight: 700, padding: "3px 9px", borderRadius: 5 }}>PDF</div>
        </div>
      </div>
    ),
    size,
  );
}
