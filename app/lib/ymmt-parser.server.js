const META_KEYS = new Set(["Warning", "Compatible", "Manufacturer"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFlatModel(obj) {
  if (!isObject(obj)) return false;

  const keys = Object.keys(obj);

  return keys.length > 0 && keys.every((key) => META_KEYS.has(key));
}

function countManufacturer(stats, manufacturer) {
  if (manufacturer === "SCS") {
    stats.manufacturers.SCS++;
  } else if (manufacturer === "EKR") {
    stats.manufacturers.EKR++;
  } else {
    stats.manufacturers.Other++;
  }
}

export function parseYMMT(raw) {
  if (!isObject(raw)) {
    throw new Error("YMMT JSON must contain an object at the root level.");
  }

  const entries = [];

  const stats = {
    years: new Set(),
    makes: new Set(),
    models: new Set(),
    trims: new Set(),

    withTrim: 0,
    withoutTrim: 0,

    manufacturers: {
      SCS: 0,
      EKR: 0,
      Other: 0,
    },
  };

  for (const [year, makes] of Object.entries(raw)) {
    if (!isObject(makes)) continue;

    stats.years.add(year);

    for (const [make, models] of Object.entries(makes)) {
      if (!isObject(models)) continue;

      stats.makes.add(make);

      for (const [model, trimData] of Object.entries(models)) {
        if (!isObject(trimData)) continue;

        stats.models.add(`${make}:${model}`);

        // SCS-style:
        // year -> make -> model -> metadata
        if (isFlatModel(trimData)) {
          const entry = {
            year,
            make,
            model,
            trim: null,
            warning: trimData.Warning || "",
            compatible: trimData.Compatible || "",
            manufacturer: trimData.Manufacturer || "Unknown",
          };

          entries.push(entry);

          stats.withoutTrim++;
          countManufacturer(stats, entry.manufacturer);

          continue;
        }

        // EKR-style:
        // year -> make -> model -> trim -> metadata
        for (const [trim, details] of Object.entries(trimData)) {
          if (!isObject(details)) continue;

          const entry = {
            year,
            make,
            model,
            trim,
            warning: details.Warning || "",
            compatible: details.Compatible || "",
            manufacturer: details.Manufacturer || "Unknown",
          };

          entries.push(entry);

          stats.trims.add(trim);
          stats.withTrim++;

          countManufacturer(stats, entry.manufacturer);
        }
      }
    }
  }

  if (entries.length === 0) {
    throw new Error("No valid YMMT records were found in this file.");
  }

  return {
    entries,

    stats: {
      totalEntries: entries.length,
      totalYears: stats.years.size,
      totalMakes: stats.makes.size,
      totalModels: stats.models.size,
      totalTrims: stats.trims.size,

      years: [...stats.years].sort(),
      makes: [...stats.makes].sort(),

      withTrim: stats.withTrim,
      withoutTrim: stats.withoutTrim,

      manufacturers: stats.manufacturers,
    },
  };
}

/*
 * Temporary server-memory storage.
 *
 * This behaves similarly to the previous YMMT app.
 * Restarting `shopify app dev` clears these sessions.
 */

// export function createYMMTSession(data) {
//   const sessionId = crypto.randomUUID();

//   uploadSessions.set(sessionId, {
//     ...data,
//     createdAt: Date.now(),
//   });

//   return sessionId;
// }

// export function getYMMTSession(sessionId) {
//   return uploadSessions.get(sessionId) || null;
// }

// export function deleteYMMTSession(sessionId) {
//   return uploadSessions.delete(sessionId);
// }
