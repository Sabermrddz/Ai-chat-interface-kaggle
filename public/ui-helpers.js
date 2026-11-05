'use strict';

(function attachUiHelpers(root, factory) {
  const helpers = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = helpers;
    return;
  }

  root.ChatUI = helpers;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createUiHelpers() {
  const STATUS_FAILURE_LIMIT = 2;

  function nullableString(value) {
    return typeof value === 'string' && value ? value : null;
  }

  function evaluateStatus(previous, result) {
    const prior = previous || {};
    const failures = Number.isInteger(prior.failures) ? prior.failures : 0;
    const priorOnline = prior.online === true || prior.online === false ? prior.online : null;

    if (result && result.ok && result.data && result.data.online === true) {
      return {
        online: true,
        failures: 0,
        model: nullableString(result.data.model),
        lastSeen: nullableString(result.data.lastSeen),
        source: nullableString(result.data.source)
      };
    }

    const nextFailures = failures + 1;
    const data = result && result.ok && result.data ? result.data : null;

    return {
      online: nextFailures >= STATUS_FAILURE_LIMIT ? false : priorOnline,
      failures: nextFailures,
      model: data ? nullableString(data.model) : prior.model || null,
      lastSeen: data ? nullableString(data.lastSeen) : prior.lastSeen || null,
      source: data ? nullableString(data.source) : prior.source || null
    };
  }

  function statusPresentation(status) {
    const current = status || {};

    if (current.online === null || current.online === undefined) {
      return {
        state: 'checking',
        text: 'Checking...',
        title: 'Checking the model connection'
      };
    }

    if (current.online === false) {
      return {
        state: 'offline',
        text: 'Offline',
        title:
          current.source === 'heartbeat'
            ? 'Kaggle notebook is offline'
            : 'The model connection is offline'
      };
    }

    const model = nullableString(current.model);
    const source = nullableString(current.source);
    let label = 'Connected';

    if (source === 'heartbeat') {
      label = 'Kaggle connected';
    } else if (source === 'manual' || source === 'env') {
      label = 'Model connected';
    }

    return {
      state: 'online',
      text: model ? `${label} \u00b7 ${model}` : label,
      title:
        source === 'heartbeat' && current.lastSeen
          ? `Last heartbeat: ${new Date(current.lastSeen).toLocaleString()}`
          : 'Connected to the model server'
    };
  }

  function authIsRequired(data) {
    return Boolean(data && data.required && data.authenticated === false);
  }

  function finalizeStreamText(text, aborted) {
    const value = typeof text === 'string' ? text : '';
    if (!value || !aborted) {
      return value;
    }
    return `${value}\n\n*Stopped.*`;
  }

  return {
    STATUS_FAILURE_LIMIT,
    evaluateStatus,
    statusPresentation,
    authIsRequired,
    finalizeStreamText
  };
});
