const { DataTypes } = require("sequelize");
const sequelize = require("../config/database.js");

const MessageChat = sequelize.define("MessageChat", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  acteur: { type: DataTypes.TEXT, allowNull: false },
  conversation_chat_id: { type: DataTypes.INTEGER, allowNull: false },
  message: { type: DataTypes.TEXT, allowNull: false },
  date_created: { type: DataTypes.DATE, allowNull: true }
}, {
  tableName: "message_chat",
  timestamps: false
});

module.exports = MessageChat;