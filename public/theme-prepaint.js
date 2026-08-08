(function () {
  "use strict";

  if (window.__COOL_THEME_BOOTSTRAP__) {
    return;
  }

  var storageKey = "cool-ai:theme:v1";
  var theme = "light";

  function isExactPreference(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }

    var descriptors = Object.getOwnPropertyDescriptors(value);
    var keys = Reflect.ownKeys(descriptors).sort();
    var expectedKeys = ["revision", "theme", "updatedAt", "version"];

    if (
      keys.length !== expectedKeys.length ||
      keys.some(function (key, index) {
        return typeof key !== "string" || key !== expectedKeys[index];
      })
    ) {
      return false;
    }

    var values = {};
    for (var index = 0; index < expectedKeys.length; index += 1) {
      var key = expectedKeys[index];
      var descriptor = descriptors[key];
      if (
        !descriptor ||
        !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value")
      ) {
        return false;
      }
      values[key] = descriptor.value;
    }

    if (
      values.version !== 1 ||
      (values.theme !== "light" && values.theme !== "dark") ||
      !Number.isSafeInteger(values.revision) ||
      values.revision < 0 ||
      typeof values.updatedAt !== "string"
    ) {
      return false;
    }

    var updatedAt = new Date(values.updatedAt);
    return (
      !Number.isNaN(updatedAt.getTime()) &&
      updatedAt.toISOString() === values.updatedAt
    );
  }

  try {
    var stored = window.localStorage.getItem(storageKey);
    if (typeof stored === "string") {
      var preference = JSON.parse(stored);
      if (isExactPreference(preference)) {
        theme = preference.theme;
      }
    }
  } catch (_error) {
    theme = "light";
  }

  var documentElement = document.documentElement;
  documentElement.dataset.theme = theme;
  documentElement.style.colorScheme = theme;

  var timestamp = 0;
  try {
    var measuredAt = performance.now();
    if (Number.isFinite(measuredAt) && measuredAt >= 0) {
      timestamp = measuredAt;
    }
  } catch (_error) {
    timestamp = 0;
  }

  window.__COOL_THEME_BOOTSTRAP__ = Object.freeze({
    themeAtBootstrap: theme,
    timestamp: timestamp,
  });
})();
