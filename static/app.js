const state = {
  path: "/",
  mode: "browse",
  query: "",
  sort: "name",
  order: "asc",
  searchScope: "current",
};

const els = {
  statusPill: document.getElementById("status-pill"),
  cookieInput: document.getElementById("cookie-input"),
  saveCookieBtn: document.getElementById("save-cookie-btn"),
  logoutBtn: document.getElementById("logout-btn"),
  accountCard: document.getElementById("account-card"),
  breadcrumbs: document.getElementById("breadcrumbs"),
  refreshBtn: document.getElementById("refresh-btn"),
  mkdirBtn: document.getElementById("mkdir-btn"),
  uploadBtn: document.getElementById("upload-btn"),
  folderUploadBtn: document.getElementById("folder-upload-btn"),
  backBtn: document.getElementById("back-btn"),
  searchInput: document.getElementById("search-input"),
  searchScope: document.getElementById("search-scope"),
  searchBtn: document.getElementById("search-btn"),
  pathLabel: document.getElementById("path-label"),
  entryCount: document.getElementById("entry-count"),
  fileList: document.getElementById("file-list"),
  uploadInput: document.getElementById("upload-input"),
  folderInput: document.getElementById("folder-input"),
  toast: document.getElementById("toast"),
};

function fmtBytes(bytes) {
  if (bytes === null || bytes === undefined || bytes === "") return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes);
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return idx === 0 ? `${value.toFixed(0)}${units[idx]}` : `${value.toFixed(1)}${units[idx]}`;
}

function fmtTime(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function showToast(message, kind = "") {
  els.toast.textContent = message;
  els.toast.className = `toast show ${kind}`.trim();
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    els.toast.className = "toast";
  }, 2600);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || data.message || response.statusText);
  }
  return data;
}

function parentPath(path) {
  if (!path || path === "/") return "/";
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return `/${parts.join("/")}` || "/";
}

function splitPath(path) {
  return path.split("/").filter(Boolean);
}

function buildCrumbs(path) {
  const parts = splitPath(path);
  const crumbs = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

function renderBreadcrumbs(path) {
  els.breadcrumbs.innerHTML = "";
  for (const crumb of buildCrumbs(path)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = crumb.label;
    button.addEventListener("click", () => openPath(crumb.path));
    els.breadcrumbs.appendChild(button);
  }
}

function renderAccount(account, usage) {
  if (!account) {
    els.accountCard.className = "card-empty";
    els.accountCard.textContent = "暂无数据";
    return;
  }
  const percent = usage.total ? Math.min(100, (usage.used / usage.total) * 100) : 0;
  els.accountCard.className = "account-card";
  els.accountCard.innerHTML = `
    <div><strong>${account.user_name || "未知用户"}</strong></div>
    <div class="muted">ID: ${account.user_id || "-"}</div>
    <div class="muted">VIP: ${account.vip ? "是" : "否"}</div>
    <div class="muted">到期: ${account.expire ? fmtTime(account.expire) : "-"}</div>
    <div>
      <div class="usage-bar"><span style="width:${percent}%"></span></div>
      <div class="muted" style="margin-top:0.35rem">${usage.used_text || "0B"} / ${usage.total_text || "0B"}</div>
    </div>
  `;
}

function renderEntries(items) {
  els.fileList.innerHTML = "";
  els.entryCount.textContent = `${items.length} 项`;
  if (!items.length) {
    const row = document.createElement("tr");
    row.innerHTML = '<td colspan="4" class="muted">当前目录为空。</td>';
    els.fileList.appendChild(row);
    return;
  }

  for (const item of items) {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const nameWrap = document.createElement("div");
    nameWrap.className = "entry-name";
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = item.is_directory ? "DIR" : (item.file_type || "FILE").toUpperCase().slice(0, 4);
    const link = document.createElement(item.is_directory ? "button" : "span");
    if (item.is_directory) {
      link.type = "button";
      link.className = "folder-link";
      link.textContent = item.name;
      link.addEventListener("click", () => openPath(item.path || joinPath(state.path, item.name)));
      link.addEventListener("dblclick", () => openPath(item.path || joinPath(state.path, item.name)));
      link.style.background = "transparent";
      link.style.border = "none";
      link.style.padding = "0";
      link.style.textAlign = "left";
    } else {
      link.textContent = item.name;
    }
    nameWrap.appendChild(badge);
    nameWrap.appendChild(link);
    nameCell.appendChild(nameWrap);

    const sizeCell = document.createElement("td");
    sizeCell.textContent = item.is_directory ? `${item.file_count || 0} 项` : (item.size_text || fmtBytes(item.size));

    const timeCell = document.createElement("td");
    timeCell.textContent = item.modified_time ? fmtTime(item.modified_time) : (item.created_time ? fmtTime(item.created_time) : "");

    const actionCell = document.createElement("td");
    const actions = document.createElement("div");
    actions.className = "entry-actions";
    if (!item.is_directory) {
      actions.appendChild(makeActionButton("下载", () => window.open(`/api/download?path=${encodeURIComponent(item.path)}`, "_blank")));
      actions.appendChild(makeActionButton("复制链接", () => copyDirectUrl(item.path)));
    }
    actions.appendChild(makeActionButton("重命名", () => renameEntry(item.path)));
    actions.appendChild(makeActionButton("删除", () => deleteEntry(item.path, item.is_directory)));
    actionCell.appendChild(actions);

    row.appendChild(nameCell);
    row.appendChild(sizeCell);
    row.appendChild(timeCell);
    row.appendChild(actionCell);
    els.fileList.appendChild(row);
  }
}

function makeActionButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}

function joinPath(base, part) {
  if (!base || base === "/") return `/${part}`.replace(/\/+/g, "/");
  return `${base.replace(/\/+$/, "")}/${part}`.replace(/\/+/g, "/");
}

async function loadAccount() {
  const result = await api("/api/account");
  renderAccount(result.account, result.usage);
  els.statusPill.textContent = `已登录: ${result.account.user_name || "115"}`;
}

async function loadStatus() {
  const result = await api("/api/status");
  if (result.authenticated) {
    els.statusPill.textContent = "已连接";
    await loadAccount();
    await openPath(state.path, true);
  } else {
    els.statusPill.textContent = "未连接";
    renderAccount(null);
  }
}

async function openPath(path, quiet = false) {
  state.mode = "browse";
  state.path = path || "/";
  state.query = "";
  els.searchInput.value = "";
  renderBreadcrumbs(state.path);
  els.pathLabel.textContent = state.path;
  try {
    const result = await api(
      `/api/entries?path=${encodeURIComponent(state.path)}&sort=${encodeURIComponent(state.sort)}&order=${encodeURIComponent(state.order)}&limit=500&offset=0`
    );
    renderEntries(result.items || []);
    if (!quiet) showToast(`已打开 ${state.path}`, "success");
  } catch (error) {
    renderEntries([]);
    showToast(error.message, "error");
  }
}

async function search() {
  const query = els.searchInput.value.trim();
  if (!query) {
    await openPath(state.path);
    return;
  }
  state.mode = "search";
  state.query = query;
  state.searchScope = els.searchScope.value;
  try {
    const url = new URL("/api/search", window.location.origin);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "500");
    url.searchParams.set("offset", "0");
    if (state.searchScope === "current") url.searchParams.set("path", state.path);
    const result = await api(url.toString());
    renderBreadcrumbs(state.path);
    els.pathLabel.textContent = `搜索: ${query}`;
    renderEntries(result.items || []);
    showToast(`找到 ${result.items?.length || 0} 项`, "success");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function createFolder() {
  const name = window.prompt("新文件夹名称");
  if (!name) return;
  await api("/api/mkdir", {
    method: "POST",
    body: JSON.stringify({ path: state.path, name }),
  });
  showToast("文件夹已创建", "success");
  await openPath(state.path, true);
}

async function renameEntry(path) {
  const name = window.prompt("新名称");
  if (!name) return;
  await api("/api/rename", {
    method: "POST",
    body: JSON.stringify({ path, name }),
  });
  showToast("已重命名", "success");
  await openPath(state.path, true);
}

async function deleteEntry(path, isDirectory) {
  const ok = window.confirm(`确定删除${isDirectory ? "目录" : "文件"}吗？`);
  if (!ok) return;
  await api("/api/delete", {
    method: "POST",
    body: JSON.stringify({ path, recursive: isDirectory }),
  });
  showToast("已删除", "success");
  await openPath(state.path, true);
}

async function copyDirectUrl(path) {
  const result = await api(`/api/direct-url?path=${encodeURIComponent(path)}`);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(result.url);
  } else {
    window.prompt("复制下面的链接", result.url);
    return;
  }
  showToast("链接已复制", "success");
}

async function uploadFiles(files) {
  if (!files || !files.length) return;
  const form = new FormData();
  form.append("dest_path", state.path);
  for (const file of files) {
    form.append("files", file, file.webkitRelativePath || file.name);
  }
  const response = await fetch("/api/upload", {
    method: "POST",
    body: form,
  });
  const result = await response.json();
  if (!response.ok || result.ok === false) {
    throw new Error(result.error || response.statusText);
  }
  showToast(`上传完成: ${result.items?.length || 0} 个文件`, "success");
  await openPath(state.path, true);
}

els.saveCookieBtn.addEventListener("click", async () => {
  const cookie = els.cookieInput.value.trim();
  if (!cookie) {
    showToast("请先输入 Cookie", "error");
    return;
  }
  try {
    await api("/api/auth", {
      method: "POST",
      body: JSON.stringify({ cookie }),
    });
    showToast("登录信息已保存", "success");
    await loadStatus();
  } catch (error) {
    showToast(error.message, "error");
  }
});

els.logoutBtn.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: JSON.stringify({}) });
  renderAccount(null);
  els.statusPill.textContent = "未连接";
  els.fileList.innerHTML = '<tr><td colspan="4" class="muted">请先登录并加载目录。</td></tr>';
  showToast("已清除登录信息", "success");
});

els.refreshBtn.addEventListener("click", () => openPath(state.path));
els.mkdirBtn.addEventListener("click", createFolder);
els.uploadBtn.addEventListener("click", () => els.uploadInput.click());
els.folderUploadBtn.addEventListener("click", () => els.folderInput.click());
els.backBtn.addEventListener("click", () => openPath(parentPath(state.path)));
els.searchBtn.addEventListener("click", search);
els.searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") search();
});
els.uploadInput.addEventListener("change", async () => {
  try {
    await uploadFiles(Array.from(els.uploadInput.files || []));
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    els.uploadInput.value = "";
  }
});
els.folderInput.addEventListener("change", async () => {
  try {
    await uploadFiles(Array.from(els.folderInput.files || []));
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    els.folderInput.value = "";
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    els.searchInput.blur();
  }
});

loadStatus().catch((error) => showToast(error.message, "error"));
