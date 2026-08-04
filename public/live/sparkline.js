// Mini-gráfica de línea continua (Canvas) + estadísticas (prom/máx/mín) para una serie
// de muestras a lo largo de una sesión. Usado tanto en el resumen al terminar de remar
// como en el detalle de una sesión pasada en el Historial.

export function computeStats(values) {
  const clean = values.filter((v) => v != null && v > 0);
  if (!clean.length) return { avg: 0, max: 0, min: 0, count: 0 };
  return {
    avg: clean.reduce((a, b) => a + b, 0) / clean.length,
    max: Math.max(...clean),
    min: Math.min(...clean),
    count: clean.length,
  };
}

// series: [{t, v}], puede incluir v=0/null (huecos) — se ignoran al escalar pero no rompen la línea.
// unit/decimals controlan cómo se rotulan el máximo (arriba) y el mínimo (abajo) de la escala.
export function drawSparkline(canvas, series, { color = "#4f8dff", fillColor = "rgba(79,141,255,0.18)", unit = "", decimals = 0 } = {}) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.clientWidth || 300;
  const height = canvas.clientHeight || 56;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const points = series.filter((p) => p.v != null && p.v > 0);
  if (points.length < 2) return;

  const values = points.map((p) => p.v);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const minT = points[0].t;
  const maxT = points[points.length - 1].t || 1;
  const spanT = maxT - minT || 1;
  const padX = 4;
  const padY = 14; // deja espacio arriba/abajo para las etiquetas de escala

  const xOf = (t) => padX + ((t - minT) / spanT) * (width - padX * 2);
  const yOf = (v) => height - padY - ((v - min) / range) * (height - padY * 2);

  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xOf(p.t);
    const y = yOf(p.v);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  ctx.lineTo(xOf(points[points.length - 1].t), height);
  ctx.lineTo(xOf(points[0].t), height);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();

  ctx.font = "9px -apple-system, sans-serif";
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillText(`${max.toFixed(decimals)}${unit}`, width - padX, 2);
  ctx.textBaseline = "bottom";
  ctx.fillText(`${min.toFixed(decimals)}${unit}`, width - padX, height - 2);
}
