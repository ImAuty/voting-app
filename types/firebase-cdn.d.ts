// public/*.js imports the Firebase SDK straight from the gstatic CDN (no
// bundler, no build step - see DESIGN.md). TypeScript can't resolve a URL
// specifier on its own, so these ambient modules point each exact CDN URL at
// the real typings from the "firebase" npm package (already a devDependency)
// for type-checking purposes only; nothing here is bundled or shipped.
declare module "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js" {
  export * from "firebase/app";
}

declare module "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js" {
  export * from "firebase/auth";
}

declare module "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js" {
  export * from "firebase/firestore";
}
