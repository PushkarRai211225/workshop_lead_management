const runtime = window.__dvWorkshopPageRuntime || {
  cleanups: new Set()
};

window.__dvWorkshopPageRuntime = runtime;

export function registerPageCleanup(cleanup) {
  if (typeof cleanup !== "function") {
    return () => undefined;
  }

  runtime.cleanups.add(cleanup);

  return () => {
    runtime.cleanups.delete(cleanup);
  };
}

export function runPageCleanup() {
  const cleanups = Array.from(runtime.cleanups);
  runtime.cleanups.clear();

  cleanups.forEach((cleanup) => {
    try {
      cleanup();
    } catch (error) {
      console.error("Failed to clean up the previous page view.", error);
    }
  });
}