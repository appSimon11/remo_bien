// Compartir el resumen de una sesión como imagen (Fotos/Notas/lo que sea) o como texto plano.

import { fmtTime, fmtPace, state } from "./state.js";

function summaryText(s) {
  const d = new Date(s.date);
  return [
    `Remo2 — ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    ...(s.programName ? [`Programa: ${s.programName}`] : []),
    `Duración: ${fmtTime(s.durationSec)}`,
    ...(state.freeMode
      ? []
      : [
          `Distancia: ${(s.distanceM / 1000).toFixed(2)} km`,
          `Ritmo promedio: ${fmtPace(s.avgPaceSec500m)} /500m`,
          `SPM promedio: ${Math.round(s.avgSpm)}`,
          `Potencia promedio: ${Math.round(s.avgPower)} W`,
          `Calorías: ${Math.round(s.calories)}`,
          `Remadas totales: ${s.strokes}`,
        ]),
  ].join("\n");
}

function buildSummaryCanvas(s) {
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 1100;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#03040a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#f7f8ff";
  ctx.font = "bold 54px -apple-system, sans-serif";
  ctx.fillText("Remo2", 50, 90);

  const d = new Date(s.date);
  ctx.fillStyle = "#a9adbc";
  ctx.font = "28px -apple-system, sans-serif";
  ctx.fillText(`${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, 50, 140);

  ctx.strokeStyle = "rgba(255,255,255,0.14)";
  ctx.beginPath();
  ctx.moveTo(50, 175);
  ctx.lineTo(850, 175);
  ctx.stroke();

  const rows = [
    ...(s.programName ? [["Programa", s.programName]] : []),
    ["Duración", fmtTime(s.durationSec)],
    ...(state.freeMode
      ? []
      : [
          ["Distancia", `${(s.distanceM / 1000).toFixed(2)} km`],
          ["Ritmo promedio", `${fmtPace(s.avgPaceSec500m)} /500m`],
          ["SPM promedio", `${Math.round(s.avgSpm)}`],
          ["Potencia promedio", `${Math.round(s.avgPower)} W`],
          ["Calorías", `${Math.round(s.calories)}`],
          ["Remadas totales", `${s.strokes}`],
        ]),
  ];
  let y = 230;
  rows.forEach(([k, v]) => {
    ctx.fillStyle = "#a9adbc";
    ctx.font = "30px -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(k, 50, y);
    ctx.fillStyle = "#f7f8ff";
    ctx.font = "bold 40px -apple-system, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(v, 850, y);
    ctx.textAlign = "left";
    y += 108;
  });
  return canvas;
}

export async function shareSummary(summary) {
  if (!summary) return;
  const canvas = buildSummaryCanvas(summary);
  const text = summaryText(summary);

  canvas.toBlob(async (blob) => {
    if (!blob) return alert("No se pudo generar la imagen del resumen.");
    const file = new File([blob], `remo2_${Date.now()}.png`, { type: "image/png" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "Remo2", text });
        return;
      }
      if (navigator.share) {
        await navigator.share({ title: "Remo2", text });
        return;
      }
      throw new Error("navigator.share no disponible");
    } catch (err) {
      if (err && err.name === "AbortError") return;
      console.error(err);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `remo2_${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      alert("Tu navegador no soporta compartir directo — se descargó la imagen, guárdala manualmente.");
    }
  }, "image/png");
}
