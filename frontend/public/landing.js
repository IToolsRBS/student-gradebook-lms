import { loadSignedInUser, startClock } from "./shared.js";

startClock();
loadSignedInUser();

document.querySelectorAll(".report-cell-disabled").forEach((el) => {
  el.addEventListener("click", (event) => {
    event.preventDefault();
  });
});

// Ensure available report cards navigate (in case of stale disabled markup).
document.querySelectorAll(".report-cell:not(.report-cell-disabled)").forEach((el) => {
  const href = el.getAttribute("href");
  if (!href || href === "#") return;
  el.addEventListener("click", (event) => {
    // Allow normal navigation; only block if something marked the link disabled.
    if (el.getAttribute("aria-disabled") === "true") {
      event.preventDefault();
    }
  });
});
