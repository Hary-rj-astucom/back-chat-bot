require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const helmet = require("helmet");

const chatroute = require('./routes/ChatRoutes');

const app = express();
const port = process.env.PORT;
const allowedOrigins = [
    'https://www.cosma-parfumeries.com',
    `http://localhost:${port}`
];
// 30 messages/minute/IP
const chatLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30
});
// origin cors
app.use(cors({
  origin(origin, callback) {

      // Postman, curl...
      if (!origin) {
          return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
          return callback(null, true);
      }

      callback(new Error('Origin non autorisée'));
  }
}));
// prevent cross site scripting
app.use(helmet());
app.use(express.json());

// les contenue public
app.use('/public/uploads', express.static(path.join(__dirname, 'public/uploads')));

// bulle du chatbot dans le dossier widget
app.use(express.static(path.join(__dirname, 'widget')));

const prefix = "";

app.use(prefix + '/chat', chatroute, chatLimiter);

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});