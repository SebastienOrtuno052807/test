"use strict";
/* Save to OpenReader — popup logic */
const DEFAULT_SERVER = "https://70c028d443c4e881b0.gradio.live";

const $ = id => document.getElementById(id);
const statusEl = $("status");

function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls || "";
}

async function getServer() {
  const { serverUrl } = await browser.storage.local.get("serverUrl");
  return (serverUrl || DEFAULT_SERVER).replace(/\/+$/, "");
}

async function saveUrl(url, server) {
  const res = await fetch(server + "/api/items/from-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch (e) {}
    throw new Error(detail);
  }
  return res.json();
}

document.addEventListener("DOMContentLoaded", async () => {
  const serverInput = $("server");
  serverInput.value = await getServer();
  serverInput.addEventListener("change", async () => {
    const v = serverInput.value.trim().replace(/\/+$/, "");
    await browser.storage.local.set({ serverUrl: v });
    setStatus("Server URL saved.", "ok");
  });

  let tab;
  try {
    [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  } catch (e) {}
  if (!tab || !tab.url || !/^https?:/.test(tab.url)) {
    $("page-title").textContent = "(no web page in this tab)";
    $("page-url").textContent = "";
    $("save").disabled = true;
    return;
  }
  $("page-title").textContent = tab.title || tab.url;
  $("page-title").title = tab.title || tab.url;
  $("page-url").textContent = tab.url;
  $("page-url").title = tab.url;

  $("save").addEventListener("click", async () => {
    const btn = $("save");
    btn.disabled = true;
    btn.textContent = "Saving…";
    setStatus("");
    try {
      const server = await getServer();
      const item = await saveUrl(tab.url, server);
      setStatus(`Saved ✓ — ${item.title || "untitled"}`, "ok");
    } catch (e) {
      setStatus("Couldn't save: " + e.message + ". Check the server URL.", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save this page";
    }
  });
});
