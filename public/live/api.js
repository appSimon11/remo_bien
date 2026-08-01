// Wrapper único de fetch para las rutas de "Remo en vivo" (programas, metas, récords, sesiones).
// Antes existían tres copias casi idénticas de esta función repartidas en el archivo.

export async function liveApi(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Error del servidor");
  return data;
}
