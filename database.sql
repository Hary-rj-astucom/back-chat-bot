CREATE TABLE conversation_chat(
    id INT PRIMARY KEY auto_increment,
    session_id VARCHAR(200) NOT NULL,
    date_created DATETIME NOT NULL DEFAULT NOW(),
    project_id INT NOT NULL,
    state INT NOT NULL DEFAULT 1
);

DROP TABLE IF EXISTS message_chat;
CREATE TABLE message_chat(
    id INT PRIMARY KEY auto_increment,
    acteur VARCHAR(180) NOT NULL,
    conversation_chat_id INT NOT NULL,
    message TEXT,
    date_created DATETIME NOT NULL DEFAULT NOW(),
    FOREIGN KEY (conversation_chat_id) REFERENCES conversation_chat(id)
);