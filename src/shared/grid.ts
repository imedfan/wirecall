/**
 * Where the pictures of a conference sit. Pure numbers in CSS pixels, no DOM: the view measures the
 * screen, this decides the tiles.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Splits an area into equal tiles for `count` pictures, row by row. Of every possible number of columns
 * it takes the one that gives a face the most room: wide tiles on a wide screen, tall ones on a phone
 * held upright. A last row that is not full is centred.
 */
export function gridLayout(area: Rect, count: number, gap = 0): Rect[] {
  if (count <= 0 || area.width <= 0 || area.height <= 0) return [];
  // The shape a tile should come close to: a laptop picture on a wide screen, a phone picture on a tall one.
  const shape = area.width >= area.height ? 4 / 3 : 3 / 4;
  let best = { columns: 1, rows: count, width: 0, height: 0, score: -1 };
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const width = (area.width - gap * (columns - 1)) / columns;
    const height = (area.height - gap * (rows - 1)) / rows;
    if (width <= 0 || height <= 0) continue;
    // The largest picture of that shape which fits the tile, measured by its width.
    const score = Math.min(width, height * shape);
    if (score > best.score) best = { columns, rows, width, height, score };
  }
  const rects: Rect[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = Math.floor(index / best.columns);
    const inRow = row === best.rows - 1 ? count - row * best.columns : best.columns;
    const rowWidth = inRow * best.width + (inRow - 1) * gap;
    const column = index - row * best.columns;
    rects.push({
      x: area.x + (area.width - rowWidth) / 2 + column * (best.width + gap),
      y: area.y + row * (best.height + gap),
      width: best.width,
      height: best.height,
    });
  }
  return rects;
}
