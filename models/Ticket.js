const { DataTypes } = require("sequelize");
const sequelize = require("../config/database.js");

const Ticket = sequelize.define("Ticket", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  num_ticket: { type: DataTypes.STRING(45), allowNull: false },
  subject_ticket: { type: DataTypes.STRING(45), allowNull: false },
  conversation_email_id: { type: DataTypes.TEXT, allowNull: true },
  conversation_chat_id: { type: DataTypes.INTEGER, allowNull: true },
  to_do: { type: DataTypes.TEXT, allowNull: false },
  original_client_mail: { type: DataTypes.STRING(45), allowNull: false },
  reception_mail: { type: DataTypes.STRING(45), allowNull: false },
  nom_client: { type: DataTypes.STRING(45), allowNull: true },
  num_commande: { type: DataTypes.STRING(45), allowNull: false },
  label_id: { type: DataTypes.INTEGER, allowNull: false },
  project_id: { type: DataTypes.INTEGER, allowNull: false },
  created_at: { type: DataTypes.DATE, allowNull: true },
  updated_at: { type: DataTypes.DATE, allowNull: true },
  status: { type: DataTypes.STRING(20), allowNull: true },
  need_attention: { type: DataTypes.INTEGER, allowNull: true },
  state: { type: DataTypes.INTEGER, allowNull: true},
}, {
  tableName: "ticket",
  timestamps: false
});

module.exports = Ticket;