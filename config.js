// Paste your Firebase web app config here (see README). While this is null,
// the app runs in demo mode and only saves data in your own browser.
export const firebaseConfig = {
  apiKey: "AIzaSyBo1hqUnK0boPPLUZNO9H_j7sMMpdardG4",
  authDomain: "trick-or-treat-map-cb709.firebaseapp.com",
  databaseURL: "https://trick-or-treat-map-cb709-default-rtdb.firebaseio.com",
  projectId: "trick-or-treat-map-cb709",
  storageBucket: "trick-or-treat-map-cb709.firebasestorage.app",
  messagingSenderId: "872256714367",
  appId: "1:872256714367:web:adfef1e9c17c885a38f14a"
};

// Area between Anastasia Way, Romano Dr and Sofia Dr (from OpenStreetMap).
// If you change these, update the lat/lng limits in database.rules.json too.
export const NEIGHBORHOOD = {
  bounds: [[38.8435, -121.2545], [38.8490, -121.2425]],
};
