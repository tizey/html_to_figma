type PluginMessage =
  | { type: "init"; payload: { serviceUrl: string } }
  | {
      type: "status";
      payload: { kind: "info" | "success" | "error"; message: string };
    }
  | { type: "warnings"; payload: { warnings: string[] } };

const form = getElement<HTMLFormElement>("import-form");
const serviceUrlInput = getElement<HTMLInputElement>("service-url");
const websiteUrlInput = getElement<HTMLInputElement>("website-url");
const submitButton = getElement<HTMLButtonElement>("submit-button");
const closeButton = getElement<HTMLButtonElement>("close-button");
const status = getElement<HTMLElement>("status");
const statusMessage = getElement<HTMLElement>("status-message");
const warnings = getElement<HTMLElement>("warnings");
const warningList = getElement<HTMLUListElement>("warning-list");
const presetCards = Array.from(
  document.querySelectorAll<HTMLElement>("[data-preset-card]")
);
const modeCards = Array.from(
  document.querySelectorAll<HTMLElement>("[data-mode-card]")
);

window.addEventListener("message", (event) => {
  const message = event.data?.pluginMessage as PluginMessage | undefined;

  if (!message) {
    return;
  }

  if (message.type === "init") {
    serviceUrlInput.value = message.payload.serviceUrl;
    websiteUrlInput.focus();
    return;
  }

  if (message.type === "status") {
    setStatus(message.payload.kind, message.payload.message);
    const isBusy = message.payload.kind === "info";
    setBusy(isBusy);
    return;
  }

  if (message.type === "warnings") {
    renderWarnings(message.payload.warnings);
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();

  const url = websiteUrlInput.value.trim();
  const serviceUrl = serviceUrlInput.value.trim();
  const mode =
    ((form.elements.namedItem("mode") as RadioNodeList | null)?.value ||
      "screenshot") as "screenshot" | "editable";
  const preset =
    ((form.elements.namedItem("preset") as RadioNodeList | null)?.value ||
      "mobile") as "mobile" | "desktop";

  if (!url || !serviceUrl) {
    setStatus("error", "Please fill in both the capture service URL and the website URL.");
    return;
  }

  renderWarnings([]);
  setStatus("info", "Sending the page to the capture service...");
  setBusy(true);

  parent.postMessage(
    {
      pluginMessage: {
        type: "submit-import",
        payload: {
          serviceUrl,
          url,
          mode,
          preset
        }
      }
    },
    "*"
  );
});

closeButton.addEventListener("click", () => {
  parent.postMessage({ pluginMessage: { type: "close-plugin" } }, "*");
});

form.addEventListener("change", () => {
  syncChoiceCards();
});

syncChoiceCards();

parent.postMessage({ pluginMessage: { type: "ui-ready" } }, "*");

function syncChoiceCards(): void {
  const activePreset =
    ((form.elements.namedItem("preset") as RadioNodeList | null)?.value ||
      "mobile") as "mobile" | "desktop";
  const activeMode =
    ((form.elements.namedItem("mode") as RadioNodeList | null)?.value ||
      "screenshot") as "screenshot" | "editable";

  for (const card of presetCards) {
    card.classList.toggle("is-selected", card.dataset.presetCard === activePreset);
  }

  for (const card of modeCards) {
    card.classList.toggle("is-selected", card.dataset.modeCard === activeMode);
  }

  submitButton.textContent =
    activeMode === "screenshot" ? "Import screenshot" : "Import editable frame";
}

function setStatus(
  kind: "info" | "success" | "error",
  message: string
): void {
  status.classList.add("is-visible");
  status.dataset.kind = kind;
  statusMessage.textContent = message;
}

function renderWarnings(items: string[]): void {
  warningList.innerHTML = "";

  if (items.length === 0) {
    warnings.classList.remove("is-visible");
    return;
  }

  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    warningList.appendChild(li);
  }

  warnings.classList.add("is-visible");
}

function setBusy(isBusy: boolean): void {
  submitButton.disabled = isBusy;
  serviceUrlInput.disabled = isBusy;
  websiteUrlInput.disabled = isBusy;
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing UI element: ${id}`);
  }

  return element as T;
}
