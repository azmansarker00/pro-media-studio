const { app, BrowserWindow } = require('electron');
const path = require('path');

// আপনার তৈরি করা এক্সপ্রেস ব্যাকএন্ড সার্ভার চালু করা
require('./server.js');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1000,  // অ্যাপ উইন্ডোর চওড়া (প্রয়োজনে পাল্টাতে পারবেন)
        height: 750,  // অ্যাপ উইন্ডোর উচ্চতা
        title: "Pro Media Studio",
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    // ফ্রন্টএন্ড UI লোড করা
    mainWindow.loadURL('http://localhost:5005');

    // সিকিউরিটি: ইউজার যাতে DevTools ওপেন করে কোড দেখতে না পারে
    mainWindow.webContents.on('devtools-opened', () => {
        mainWindow.webContents.closeDevTools();
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// অ্যাপ রেডি হলে উইন্ডো ওপেন হবে
app.on('ready', createWindow);

// সব উইন্ডো বন্ধ করলে অ্যাপ পুরোপুরি ক্লোজ হবে (macOS এর ডিফল্ট বিহেভিয়ার ছাড়া)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (mainWindow === null) {
        createWindow();
    }
});