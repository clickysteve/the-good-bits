// confirm-dialog.js
//
// Themed replacement for window.confirm(), since a blocking native dialog would clash with the rest
// of the UI. Pure DOM + Promise, no dependency on any app state - pulled out of app.js as one of the
// few genuinely self-contained pieces of that file.

let dialogIdCounter = 0;

export function showConfirmDialog({ title, body, confirmLabel = "Continue", cancelLabel = "Cancel", showRemember = false }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.setAttribute("role", "alertdialog");
    modal.setAttribute("aria-modal", "true");
    const titleId = `confirm-dialog-title-${++dialogIdCounter}`;
    modal.setAttribute("aria-labelledby", titleId);

    const h = document.createElement("h3");
    h.id = titleId;
    h.textContent = title;
    modal.appendChild(h);

    const p = document.createElement("p");
    p.textContent = body;
    modal.appendChild(p);

    let rememberCheckbox = null;
    if (showRemember) {
      const label = document.createElement("label");
      label.className = "checkbox-label modal-remember";
      rememberCheckbox = document.createElement("input");
      rememberCheckbox.type = "checkbox";
      label.appendChild(rememberCheckbox);
      label.append(" Use this choice for the rest of this batch");
      modal.appendChild(label);
    }

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn--ghost";
    cancelBtn.textContent = cancelLabel;
    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn btn--primary";
    confirmBtn.textContent = confirmLabel;
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    confirmBtn.focus();

    // A blocking dialog must trap both keyboard escape routes: Escape cancels (same as clicking
    // the Cancel button), and Tab/Shift+Tab cycles only through this dialog's own focusable
    // elements rather than escaping into the page underneath the overlay.
    const focusables = [rememberCheckbox, cancelBtn, confirmBtn].filter(Boolean);
    function onKeyDown(ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        close(false);
        return;
      }
      if (ev.key !== "Tab") return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);

    function close(confirmed) {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      resolve({ confirmed, remember: rememberCheckbox ? rememberCheckbox.checked : false });
    }
    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
  });
}
