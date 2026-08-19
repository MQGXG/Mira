import React from "react"
import ReactDOM from "react-dom/client"
import { PetApp } from "./pet/PetApp"
import "./styles/globals.css"

// 桌宠是透明置顶窗口，固定使用深色主题玻璃风格（透明层在浅色桌面下更清晰）
document.documentElement.classList.add("dark")

const style = document.createElement("style")
style.textContent = `*{margin:0;padding:0;box-sizing:border-box}html,body,#pet-root{width:100%;height:100%;overflow:hidden}body{background:transparent}`
document.head.appendChild(style)

ReactDOM.createRoot(document.getElementById("pet-root")!).render(
  <React.StrictMode>
    <PetApp />
  </React.StrictMode>
)
