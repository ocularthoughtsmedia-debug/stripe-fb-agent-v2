const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "reminders.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

function get(key) {
  const data = load();
  return data[key] || null;
}

function set(key, value) {
  const data = load();
  data[key] = value;
  save(data);
}

function del(key) {
  const data = load();
  delete data[key];
  save(data);
}

function all() {
  return load();
}

module.exports = { load, save, get, set, del, all };
