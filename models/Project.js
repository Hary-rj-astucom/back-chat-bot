const { DataTypes } = require("sequelize");
const sequelize = require("../config/database.js");

const Project = sequelize.define("Project", {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  name: { type: DataTypes.STRING(100), allowNull: false },
  code: { type: DataTypes.STRING(5), allowNull: false },
  state: { type: DataTypes.INTEGER, allowNull: false},
}, {
  tableName: "project",
  timestamps: false
});

module.exports = Project;
