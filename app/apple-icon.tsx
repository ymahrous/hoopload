import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", background: "#e8622c", display: "flex", alignItems: "center", justifyContent: "center", position: "relative" }}>
        <div style={{ position: "absolute", top: 34, width: 84, height: 60, border: "9px solid #fff", borderRadius: 8 }} />
        <div style={{ position: "absolute", top: 98, width: 104, height: 22, border: "9px solid #fff", borderRadius: 999 }} />
        <div style={{ position: "absolute", top: 118, width: 72, height: 34, borderLeft: "6px solid #fff", borderRight: "6px solid #fff", borderBottom: "6px solid #fff", borderRadius: "0 0 18px 18px" }} />
      </div>
    ),
    size,
  );
}
