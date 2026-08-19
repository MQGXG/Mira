import { ipcMain } from "electron"
import { createPetWindow, hidePetWindow } from "../live2d-pet/pet-manager"

export function registerLive2dIPC(): void {
  ipcMain.handle("live2d:toggle", async (_, enabled: boolean) => {
    if (enabled) {
      await createPetWindow()
    } else {
      hidePetWindow()
    }
  })
}
