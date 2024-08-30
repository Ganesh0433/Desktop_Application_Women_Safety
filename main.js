// main.js or your main Electron file
const { app, BrowserWindow, Notification } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const socketIO = require('socket.io');
const fs = require('fs');
const admin = require('firebase-admin');
const audio = require('node-web-audio-api');
const audioContext = new audio.AudioContext();

// Firebase Admin SDK setup
const serviceAccount = require('./guardian-gesture-firebase-adminsdk-vc1w6-266d1d9c74.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: 'guardian-gesture.appspot.com',
  databaseURL: 'https://guardian-gesture-default-rtdb.firebaseio.com'
});

const bucket = admin.storage().bucket();
const db = admin.database();
const localFolder = path.join(__dirname, 'downloaded_images');

if (!fs.existsSync(localFolder)) {
  fs.mkdirSync(localFolder);
}

const expressApp = express();
const server = http.createServer(expressApp);
const io = socketIO(server);

expressApp.set('view engine', 'ejs');
expressApp.set('views', path.join(__dirname, 'views'));

function showNotification(title, body) {
  new Notification({ title, body }).show();
}

function playEmergencySound() {
  const soundFile = path.join(__dirname, 'sounds', 'emergency-sound.mp3');
  
  // Read the file and convert it to an ArrayBuffer
  fs.readFile(soundFile, (err, data) => {
    if (err) {
      console.error('Error reading sound file:', err);
      return;
    }
    
    // Convert Node.js Buffer to ArrayBuffer
    const arrayBuffer = Uint8Array.from(data).buffer;

    // Decode the ArrayBuffer
    audioContext.decodeAudioData(arrayBuffer, (buffer) => {
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);
      source.start(0);
    }, (error) => {
      console.error('Error decoding audio data:', error);
    });
  });
}


function downloadImagesFromFirebase() {
  bucket.getFiles({ prefix: 'images/' }, (err, files) => {
    if (err) {
      console.error('Error getting files from Firebase Storage:', err);
      return;
    }

    files.forEach(file => {
      if (file.name.endsWith('.jpg')) {
        const localPath = path.join(localFolder, path.basename(file.name));
        if (!fs.existsSync(localPath)) {
          file.download({ destination: localPath }, (err) => {
            if (err) {
              console.error('Error downloading file:', err);
              return;
            }
            console.log(`Downloaded ${localPath}`);
            io.emit('new_image', { filename: path.basename(file.name) });
            
            // Show the notification here
            showNotification("Emergency Detected", `Image ${path.basename(file.name)} has been downloaded.`);
            
            // Play the emergency sound
            playEmergencySound();
          });
        }
      }
    });
  });
}

setInterval(downloadImagesFromFirebase, 5000);

expressApp.get('/', (req, res) => {
  fs.readdir(localFolder, (err, files) => {
    if (err) {
      console.error('Error reading local folder:', err);
      res.sendStatus(500);
      return;
    }

    const imageFiles = files.filter(file => file.endsWith('.jpg'));

    const locationRef = db.ref('location');
    locationRef.once('value', (snapshot) => {
      const locationData = snapshot.val();
      res.render('index', { imageFiles, locationData });
    });
  });
});

expressApp.get('/image/:filename', (req, res) => {
  const fileName = req.params.filename;
  const filePath = path.join(localFolder, fileName);
  res.sendFile(filePath);
});

const PORT = process.env.PORT || 3003;
server.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let storefilename = new Set();
io.on('connection', (socket) => {
  console.log('A client connected');

  fs.readdir(localFolder, (err, files) => {
    if (err) {
      console.error('Error reading the local folder:', err);
      return;
    }

    const imageFiles = files
      .filter(file => file.endsWith('.jpg'))
      .slice(-10); // Get the last 10 files

    // Extract hour and minute from the filename
    const extractTime = filename => {
      const timeString = filename.slice(-10, -4); // Get the last 6 digits before '.jpg'
      const hour = parseInt(timeString.slice(0, 2));
      const minute = parseInt(timeString.slice(2, 4));
      return { hour, minute };
    };

    // Get the time of the last file
    const lastFileTime = extractTime(imageFiles[imageFiles.length - 1]);

    // Filter files within a 2-minute range from the last file
    const filteredFiles = imageFiles.filter(file => {
      const { hour, minute } = extractTime(file);
      const timeDifference = (lastFileTime.hour * 60 + lastFileTime.minute) - (hour * 60 + minute);
      return timeDifference >= 0 && timeDifference <= 2;
    });

    filteredFiles.forEach(file => {
      if (!storefilename.has(file)) { // Check if the file has not been emitted
        socket.emit('new_image', { filename: file });
        storefilename.add(file); // Add the file to the Set after emitting
      }
    });

  });

  socket.emit('location_data', { latitude: '12.9716', longitude: '77.5946' });
});
