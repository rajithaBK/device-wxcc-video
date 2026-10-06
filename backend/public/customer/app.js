// Device web app. The backend creates the meeting, routes the WxCC task, and
// dials this RoomOS device into the meeting through Cloud xAPI.
const API_ORIGIN = window.VIDEO_SUPPORT_API_ORIGIN || window.location.origin;
const BACKEND_URL = `${API_ORIGIN}/api/request-support`;

const welcomeView = document.getElementById("welcome-view");
const dialog = document.getElementById("customer-dialog");
const form = document.getElementById("customer-form");
const nameInput = document.getElementById("customer-name");
const birthYearInput = document.getElementById("birth-year");
const connectWithInput = document.getElementById("connect-with");
const formError = document.getElementById("form-error");
const connectButton = document.getElementById("connect");
const statusView = document.getElementById("status-view");
const statusSpinner = document.getElementById("status-spinner");
const statusSuccess = document.getElementById("status-success");
const statusTitle = document.getElementById("status-title");
const statusMessage = document.getElementById("status-message");
const tryAgainButton = document.getElementById("try-again");

const currentYear = new Date().getFullYear();
birthYearInput.min = String(currentYear - 120);
birthYearInput.max = String(currentYear);

document.getElementById("get-started").addEventListener("click", () => {
  formError.textContent = "";
  dialog.showModal();
  nameInput.focus();
});

document.getElementById("close-dialog").addEventListener("click", () => {
  dialog.close();
});

dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

connectWithInput.addEventListener("change", () => {
  formError.textContent = "";
});

tryAgainButton.addEventListener("click", reset);
form.addEventListener("submit", startSupportSession);

async function startSupportSession(event) {
  event.preventDefault();
  formError.textContent = "";

  const customerName = nameInput.value.trim();
  const birthYear = Number(birthYearInput.value);
  const selected = form.querySelector('input[name="connectWith"]:checked');
  const connectWith = selected ? selected.value : "";
  if (!customerName) {
    formError.textContent = "Enter your name.";
    nameInput.focus();
    return;
  }
  if (!Number.isInteger(birthYear) || birthYear < currentYear - 120 || birthYear > currentYear) {
    formError.textContent = "Enter a valid four-digit year of birth.";
    birthYearInput.focus();
    return;
  }
  if (!connectWith) {
    formError.textContent = "Choose the specialist you would like to connect with.";
    connectWithInput.querySelector("input").focus();
    return;
  }

  connectButton.disabled = true;
  dialog.close();
  welcomeView.hidden = true;
  statusView.hidden = false;
  showPending();

  try {
    const response = await fetch(BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerName, birthYear, connectWith }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.detail || data.error || "The request failed.");
    }
    if (data.taskStatus !== "ok") {
      throw new Error("We could not route your support request.");
    }
    if (!String(data.dialStatus || "").startsWith("ok")) {
      throw new Error("We could not connect this device to the meeting.");
    }
    showSuccess();
  } catch (error) {
    showError(error);
  } finally {
    connectButton.disabled = false;
  }
}

function showPending() {
  statusSpinner.hidden = false;
  statusSuccess.hidden = true;
  tryAgainButton.hidden = true;
  statusTitle.textContent = "Connecting you";
  statusMessage.textContent =
    "We’re creating your meeting and finding a specialist.";
}

function showSuccess() {
  statusSpinner.hidden = true;
  statusSuccess.hidden = false;
  statusTitle.textContent = "You’re connected";
  statusMessage.textContent =
    "This device is joining the meeting. A support specialist will be with you shortly.";
}

function showError(error) {
  console.error("Could not start support session", error);
  statusSpinner.hidden = true;
  statusSuccess.hidden = true;
  tryAgainButton.hidden = false;
  statusTitle.textContent = "Unable to connect";
  statusMessage.textContent =
    error && error.message
      ? error.message
      : "Please check the connection and try again.";
}

function reset() {
  statusView.hidden = true;
  welcomeView.hidden = false;
  formError.textContent = "";
}
