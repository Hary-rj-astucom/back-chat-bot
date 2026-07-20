require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');

const chatroute = require('./routes/ChatRoutes');

const app = express();
const port = process.env.PORT;

app.use(express.json())

app.use('/chat', chatroute);

// Start the server
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});