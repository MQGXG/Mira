import { BrowserWindow, app } from "electron";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { findVitePort } from "../managers/window-manager";

const isDev = !app.isPackaged;

let petWindow: BrowserWindow | null = null;

interface PetBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

function boundsPath(): string {
  return join(app.getPath("userData"), "pet-bounds.json");
}

function loadBounds(): PetBounds {
  try {
    const p = boundsPath();
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8")) as PetBounds;
    }
  } catch { /* ignore */ }
  return { width: 280, height: 380 };
}

function saveBoundsToFile(bounds: PetBounds): void {
  try {
    writeFileSync(boundsPath(), JSON.stringify(bounds), "utf-8");
  } catch { /* ignore */ }
}

function trackBounds(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const [w, h] = petWindow.getSize();
  const [x, y] = petWindow.getPosition();
  saveBoundsToFile({ x, y, width: w, height: h });
}

export async function createPetWindow(): Promise<BrowserWindow | null> {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.show();
    petWindow.focus();
    return petWindow;
  }

  const bounds = loadBounds();

  petWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 200,
    minHeight: 300,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  petWindow.on("close", (event) => {
    if (!(app as any).isQuitting) {
      event.preventDefault();
      petWindow?.hide();
    }
  });

  petWindow.on("resize", trackBounds);
  petWindow.on("move", trackBounds);

  if (isDev) {
    const port = await findVitePort();
    await petWindow.loadURL(`http://localhost:${port}/pet.html`);
  } else {
    await petWindow.loadFile(join(__dirname, "../dist/pet.html"));
  }

  if (isDev) {
    petWindow.webContents.openDevTools({ mode: "detach" });
  }

  return petWindow;
}

export function hidePetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) {
    trackBounds();
    petWindow.hide();
  }
}

export function showPetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) {
    trackBounds();
    petWindow.show();
    petWindow.focus();
  }
}

export function destroyPetWindow(): void {
  if (petWindow && !petWindow.isDestroyed()) {
    petWindow.destroy();
  }
  petWindow = null;
}

export function getPetWindow(): BrowserWindow | null {
  return petWindow;
}
