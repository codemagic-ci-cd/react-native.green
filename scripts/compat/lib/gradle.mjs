// The Gradle wrapper of a demo app's Android project. The React Native version dictates the Gradle
// version (its Android Gradle plugin refuses older ones), so the wrapper is set to what the React
// Native app template for the target line uses, in every case: a demo app's committed wrapper can be
// wrong even for its own React Native version.

export const WRAPPER_PROPERTIES = 'android/gradle/wrapper/gradle-wrapper.properties';
export const TEMPLATE_WRAPPER_PROPERTIES = `package/template/${WRAPPER_PROPERTIES}`;

/** The distributionUrl value as written in the file ("https\://services.gradle.org/..."), or null. */
export function distributionUrlOf(properties) {
  return /^distributionUrl=(.+?)\s*$/m.exec(properties)?.[1] ?? null;
}

/** The same file with distributionUrl replaced; every other line is kept as it was. */
export function withDistributionUrl(properties, url) {
  return properties.replace(/^distributionUrl=.*$/m, `distributionUrl=${url}`);
}

/** "https\://services.gradle.org/distributions/gradle-9.4.1-bin.zip" -> "9.4.1", for logs. */
export function gradleVersionOf(url) {
  return /gradle-([\w.-]+?)-(?:bin|all)\.zip/.exec(url ?? '')?.[1] ?? url;
}

/**
 * The change to make, or null when there is nothing to change or no template value to take.
 * @returns {{ from: string, to: string } | null}
 */
export function planGradleWrapper(currentProperties, templateUrl) {
  const from = distributionUrlOf(currentProperties ?? '');
  if (!from || !templateUrl || from === templateUrl) return null;
  return { from, to: templateUrl };
}
