import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PlayerCard } from "./types";

export class PlayerStore {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
  }

  async flush(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending.values()]);
  }

  private file(scope: string, id: string) {
    if (id !== "library" && !/^[0-9a-f-]{36}$/.test(id))
      throw new Error("Invalid player reference");
    return join(
      this.root,
      createHash("sha256").update(scope).digest("hex"),
      `${id}.json`,
    );
  }

  async read(scope: string, id: string): Promise<PlayerCard> {
    const file = this.file(scope, id);
    await this.pending.get(file);
    try {
      return JSON.parse(await readFile(file, "utf8")) as PlayerCard;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "ENOENT" &&
        id === "library"
      )
        return { id, keyword: "", seasons: [] };
      throw error;
    }
  }

  async write(scope: string, card: PlayerCard): Promise<void> {
    const file = this.file(scope, card.id);
    const previous = this.pending.get(file) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        const temporary = `${file}.${randomUUID()}.tmp`;
        await mkdir(dirname(file), { recursive: true });
        await writeFile(temporary, JSON.stringify(card), "utf8");
        await rename(temporary, file);
      });
    this.pending.set(file, current);
    try {
      await current;
    } finally {
      if (this.pending.get(file) === current) this.pending.delete(file);
    }
  }
}
