function activatePortfolioTabs({ tabSelector, panelSelector, tabKey, panelKey, target, ownerKey, owner }) {
  document.querySelectorAll(tabSelector).forEach((tab) => {
    if (ownerKey && tab.dataset[ownerKey] !== owner) {
      return;
    }
    const active = tab.dataset[tabKey] === target;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });

  document.querySelectorAll(panelSelector).forEach((panel) => {
    if (ownerKey && panel.dataset[ownerKey] !== owner) {
      return;
    }
    const active = panel.dataset[panelKey] === target;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
  fitPortfolioTimelineBlockLabels();
}

function fitPortfolioTimelineBlockLabels() {
  requestAnimationFrame(() => {
    document.querySelectorAll(".portfolio-timeline-block-label").forEach((label) => {
      if (label.offsetParent === null) return;
      const fullLabel = label.dataset.fullLabel || label.textContent || "";
      const words = fullLabel.split(/\s+/).filter(Boolean);
      for (let length = words.length; length > 0; length -= 1) {
        label.textContent = words.slice(0, length).join(" ");
        if (label.scrollWidth <= label.clientWidth + 1) return;
      }
      label.textContent = words[0] || "kind";
    });
  });
}

function portfolioStatus(message) {
  const status = document.querySelector("[data-testid='portfolio-live-status']");
  if (!status) return;
  status.textContent = message;
}

function portfolioCardFor(element) {
  return element?.closest?.("[data-testid='portfolio-card']") || null;
}

function portfolioCardData(card) {
  const script = card?.querySelector("[data-portfolio-card-data]");
  if (!script) return {};
  try {
    return JSON.parse(script.textContent || "{}");
  } catch {
    return {};
  }
}

function selectPortfolioCard(card) {
  if (!card) return;
  const panel = card.closest("[data-portfolio-type-panel]");
  panel?.querySelectorAll("[data-testid='portfolio-card'].selected").forEach((item) => {
    if (item !== card) item.classList.remove("selected");
  });
  card.classList.toggle("selected");
  const data = portfolioCardData(card);
  portfolioStatus(card.classList.contains("selected") ? `Selected ${data.title || card.dataset.portfolioCardTitle || "portfolio card"}` : "Selection cleared");
}

function openPortfolioRaw(card) {
  const modal = document.querySelector("[data-testid='portfolio-raw-modal']");
  const title = modal?.querySelector("#portfolioRawTitle");
  const output = modal?.querySelector("[data-portfolio-raw-output]");
  if (!modal || !title || !output) return;
  const data = portfolioCardData(card);
  title.textContent = data.title || card?.dataset.portfolioCardTitle || "Portfolio card";
  output.textContent = JSON.stringify(data.raw || data, null, 2);
  modal.hidden = false;
  modal.dataset.rawText = output.textContent;
  modal.querySelector("[data-portfolio-action='close-raw']")?.focus();
  portfolioStatus(`Opened raw specimen for ${title.textContent}`);
}

function closePortfolioRaw() {
  const modal = document.querySelector("[data-testid='portfolio-raw-modal']");
  if (!modal) return;
  modal.hidden = true;
  portfolioStatus("Closed raw specimen");
}

async function copyPortfolioRaw() {
  const modal = document.querySelector("[data-testid='portfolio-raw-modal']");
  const rawText = modal?.dataset.rawText || "";
  if (!rawText) return;
  try {
    await navigator.clipboard.writeText(rawText);
    portfolioStatus("Copied raw specimen JSON");
  } catch {
    portfolioStatus("Raw specimen JSON is selected in the dialog");
  }
}

async function copyPortfolioCardJson(card) {
  const data = portfolioCardData(card);
  const rawText = JSON.stringify(data.raw || data, null, 2);
  if (!rawText) return;
  try {
    await navigator.clipboard.writeText(rawText);
    portfolioStatus(`Copied JSON for ${data.title || card?.dataset.portfolioCardTitle || "portfolio card"}`);
  } catch {
    openPortfolioRaw(card);
    portfolioStatus("Opened raw specimen because clipboard access was unavailable");
  }
}

function switchPortfolioDetailTab(button) {
  const card = button.closest(".portfolio-detail-window");
  const target = button.dataset.portfolioDetailTab;
  if (!card || !target) return;
  card.querySelectorAll("[data-portfolio-detail-tab]").forEach((tab) => {
    const active = tab.dataset.portfolioDetailTab === target;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  card.querySelectorAll("[data-portfolio-detail-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.portfolioDetailPanel !== target;
  });
  const data = portfolioCardData(card);
  portfolioStatus(`Showing ${target} for ${data.title || "message detail"}`);
}

function togglePortfolioSection(button) {
  const section = button.closest(".portfolio-section");
  if (!section) return;
  const expanded = !section.classList.contains("expanded");
  section.classList.toggle("expanded", expanded);
  button.setAttribute("aria-expanded", String(expanded));
  button.textContent = expanded ? "Collapse" : "Expand";
}

function togglePortfolioPin(button) {
  const card = button.closest(".portfolio-detail-window");
  if (!card) return;
  const pinned = !card.classList.contains("pinned");
  card.classList.toggle("pinned", pinned);
  button.setAttribute("aria-pressed", String(pinned));
  portfolioStatus(pinned ? "Pinned message detail specimen" : "Unpinned message detail specimen");
}

function closePortfolioDetail(button) {
  const card = button.closest(".portfolio-detail-window");
  if (!card) return;
  card.hidden = true;
  portfolioStatus("Closed message detail specimen");
}

document.querySelectorAll("[data-portfolio-view-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    activatePortfolioTabs({
      tabSelector: "[data-portfolio-view-tab]",
      panelSelector: "[data-portfolio-view-panel]",
      tabKey: "portfolioViewTab",
      panelKey: "portfolioViewPanel",
      target: tab.dataset.portfolioViewTab,
    });
  });
});

document.querySelectorAll("[data-portfolio-surface-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    activatePortfolioTabs({
      tabSelector: "[data-portfolio-surface-tab]",
      panelSelector: "[data-portfolio-surface-panel]",
      tabKey: "portfolioSurfaceTab",
      panelKey: "portfolioSurfacePanel",
      target: tab.dataset.portfolioSurfaceTab,
      ownerKey: "portfolioViewOwner",
      owner: tab.dataset.portfolioViewOwner,
    });
  });
});

document.querySelectorAll("[data-portfolio-type-tab]").forEach((tab) => {
  tab.addEventListener("click", () => {
    activatePortfolioTabs({
      tabSelector: "[data-portfolio-type-tab]",
      panelSelector: "[data-portfolio-type-panel]",
      tabKey: "portfolioTypeTab",
      panelKey: "portfolioTypePanel",
      target: tab.dataset.portfolioTypeTab,
      ownerKey: "portfolioSurfaceOwner",
      owner: tab.dataset.portfolioSurfaceOwner,
    });
  });
});

document.addEventListener("click", (event) => {
  const actionElement = event.target.closest("[data-portfolio-action]");
  if (!actionElement) {
    if (event.target.matches("[data-testid='portfolio-raw-modal']")) closePortfolioRaw();
    return;
  }
  const action = actionElement.dataset.portfolioAction;
  if (action === "raw") openPortfolioRaw(portfolioCardFor(actionElement));
  if (action === "close-raw") closePortfolioRaw();
  if (action === "copy-raw") copyPortfolioRaw();
  if (action === "copy-card-json") copyPortfolioCardJson(portfolioCardFor(actionElement));
  if (action === "select-card") selectPortfolioCard(portfolioCardFor(actionElement));
  if (action === "toggle-section") togglePortfolioSection(actionElement);
  if (action === "pin-detail") togglePortfolioPin(actionElement);
  if (action === "close-detail") closePortfolioDetail(actionElement);
});

document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-portfolio-detail-tab]");
  if (tab) switchPortfolioDetailTab(tab);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePortfolioRaw();
  if (!["Enter", " "].includes(event.key)) return;
  const card = event.target.closest("[data-portfolio-action='select-card'][role='button']");
  if (!card) return;
  event.preventDefault();
  selectPortfolioCard(card);
});

fitPortfolioTimelineBlockLabels();
