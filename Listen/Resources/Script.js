// Called from ViewController.swift with whether Listen is turned on in Safari (or null if unknown).
// The second argument is kept from the template (Safari 16+ says "Settings", not "Preferences").
function show(enabled, useSettingsInsteadOfPreferences) {
    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
