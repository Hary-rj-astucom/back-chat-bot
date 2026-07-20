const { DataTypes } = require("sequelize");
const sequelize = require("../config/database.js");

const ConversationChat = sequelize.define("ConversationChat", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  session_id: { type: DataTypes.TEXT, allowNull: false },
  date_created: { type: DataTypes.DATE, allowNull: true },
  project_id: { type: DataTypes.INTEGER, allowNull: false },
  state: { type: DataTypes.INTEGER, allowNull: true  }
}, {
  tableName: "conversation_chat",
  timestamps: false
});

module.exports = ConversationChat;