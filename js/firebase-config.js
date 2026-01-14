// Firebase SDK CDN 방식으로 import
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-analytics.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.7.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyA3JNwfunGu1x33fLiv5n9Z4y8DxNdVZLU",
    authDomain: "dearu-test-device-rental.firebaseapp.com",
    projectId: "dearu-test-device-rental",
    storageBucket: "dearu-test-device-rental.firebasestorage.app",
    messagingSenderId: "275456727890",
    appId: "1:275456727890:web:e5e3da87be93c1fff0b88b",
    measurementId: "G-0ESNTF013X"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const db = getFirestore(app);

// 전역으로 사용 가능하게
window.db = db;

export { db, analytics, app };
