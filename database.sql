-- new table in cosmia --

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

-- projet --
CREATE TABLE `project` (
  `id` int NOT NULL,
  `code` varchar(5) COLLATE utf8mb4_general_ci NOT NULL,
  `name` varchar(20) COLLATE utf8mb4_general_ci NOT NULL,
  `state` int NOT NULL DEFAULT '1'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

--
-- Dumping data for table `project`
--

INSERT INTO `project` (`id`, `code`, `name`, `state`) VALUES
(1, 'COSHP', 'COSMASHOP', 1),
(2, 'COSPA', 'COSMA-PARFUMERIE', 1),
(3, 'DIGIP', 'DIGIPARF', 1);

ALTER TABLE `project`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `project`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=4;
COMMIT;

-- old table in cosmia --
CREATE TABLE ticket (
    id INT PRIMARY KEY auto_increment,
    num_ticket VARCHAR(45) NOT NULL,
    subject_ticket VARCHAR(255) NOT NULL,
    conversation_email_id TEXT NOT NULL,
    conversation_chat_id INT DEFAULT NULL, -- nouvel colonne
    to_do TEXT NOT NULL,
    original_client_mail VARCHAR(45) NOT NULL,
    reception_mail VARCHAR(45) NOT NULL,
    nom_client VARCHAR(45) DEFAULT NULL,
    num_commande VARCHAR(45) NOT NULL,
    label_id INT NOT NULL,
    project_id INT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT NOW(),
    status ENUM ('en attente', 'en cours', 'cloture') DEFAULT 'en attente',
    need_attention TINYINT NOT NULL DEFAULT 0,
    state INT NOT NULL DEFAULT 1
);