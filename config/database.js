const dotenv = require('dotenv');
dotenv.config();

const { Sequelize } = require("sequelize");

const sequelize = new Sequelize(
  process.env.DATABASE_NAME,
  process.env.DATABASE_USER,
  process.env.DATABASE_PWD,
  {
    host: process.env.HOST,
    dialect: "mysql",
    logging: false,
    define: {
      timestamps: false
    }
  }
);

module.exports = sequelize;