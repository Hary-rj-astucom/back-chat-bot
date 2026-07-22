require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const chatroute = require('./routes/ChatRoutes');

const app = express();
const port = process.env.PORT;

app.use(cors());
app.use(express.json())

// les contenue public
app.use('/public/uploads', express.static(path.join(__dirname, 'public/uploads')));

// bulle du chatbot dans le dossier widget
app.use(express.static(path.join(__dirname, 'widget')));

app.use('/chat', chatroute);

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});