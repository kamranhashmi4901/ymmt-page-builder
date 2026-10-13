import db from "../db.server";

const cell = (v) => {
  let text = String(v ?? "");
  if (/^[\s]*[=+\-@]|^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};
export async function pageUpdateCsv(shop, id) {
  const session = await db.pageActionSession.findFirst({
    where: { shop, id },
    select: { id: true },
  });
  if (!session)
    throw new Response("Session not found for this store.", { status: 404 });
  const lines = [
    ["Page ID", "Page Handle", "Vehicle", "Compatibility", "Warning"]
      .map(cell)
      .join(","),
  ];
  let cursor;
  for (;;) {
    const rows = await db.pageChangeLog.findMany({
      where: { sessionId: id, status: "success", rolledBackAt: null },
      select: { id: true, shopifyPageId: true, handle: true, afterData: true },
      orderBy: { id: "asc" },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const row of rows) {
      let snapshot = {},
        vehicle = {};
      try {
        snapshot = JSON.parse(row.afterData || "{}");
        const field = snapshot.metafields?.nodes?.find(
          (m) => m.namespace === "ymmt" && m.key === "vehicle",
        );
        vehicle = JSON.parse(snapshot.vehicle?.value || field?.value || "{}");
      } catch {
        /* Unknown recorded values stay blank. */
      }
      lines.push(
        [
          row.shopifyPageId.split("/").pop(),
          row.handle,
          [vehicle.year, vehicle.make, vehicle.model, vehicle.trim]
            .filter(Boolean)
            .join(" "),
          vehicle.compatible || vehicle.compat || "",
          vehicle.warning || "",
        ]
          .map(cell)
          .join(","),
      );
    }
    if (rows.length < 100) break;
    cursor = rows[rows.length - 1].id;
  }
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}
