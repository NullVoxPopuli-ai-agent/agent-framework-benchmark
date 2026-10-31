-- Changes applied to the API's data after the app is built (tests/run.mjs sets API_OVERLAY
-- to this file). An app that baked data in at build time won't show them.

-- A new friend who has the five lowest-numbered species the trainer still needs.
INSERT INTO friend (id, name, friend_code, since) VALUES (151, 'Benchmon Fan', 'SW-0151-0151-0151', '2026-10-01');
INSERT INTO friend_game (friend_id, game_id) SELECT 151, game_id FROM my_game ORDER BY game_id LIMIT 3;
INSERT INTO friend_species (friend_id, species_id)
  SELECT 151, id FROM species WHERE id NOT IN (SELECT species_id FROM catch) ORDER BY id LIMIT 5;

-- Today, they traded the trainer the lowest-numbered species the trainer needed.
INSERT INTO trade (id, traded_at, friend_id, game_id, gave_id, received_id, evolved)
  SELECT (SELECT MAX(id) + 1 FROM trade), (SELECT value FROM meta WHERE key = 'today'), 151,
         (SELECT game_id FROM my_game ORDER BY game_id LIMIT 1), 25,
         (SELECT MIN(id) FROM species WHERE id NOT IN (SELECT species_id FROM catch)), 0;
INSERT INTO catch (species_id, game_id, caught_at, level, shiny, method, ball, nickname, trade_id, hunt_id)
  SELECT received_id, game_id, traded_at, 1, 0, 'Trade', NULL, NULL, id, NULL FROM trade WHERE id = (SELECT MAX(id) FROM trade);

-- Every active shiny hunt has had more encounters since.
UPDATE hunt SET encounters = encounters + 1000 WHERE status = 'active';

-- Yesterday's activity, so detail pages change too (dated yesterday so the trade above stays
-- the newest). Friend 1 traded the trainer an Eevee for a Slowpoke in Red; friend 8 traded a
-- Slowpoke for a Pikachu in Blue; and a Nidoran♂ (needed until now) was caught in Blue.
INSERT INTO trade (id, traded_at, friend_id, game_id, gave_id, received_id, evolved)
  SELECT (SELECT MAX(id) + 1 FROM trade), date(value, '-1 day'), 1, 'red', 79, 133, 0 FROM meta WHERE key = 'today';
INSERT INTO trade (id, traded_at, friend_id, game_id, gave_id, received_id, evolved)
  SELECT (SELECT MAX(id) + 1 FROM trade), date(value, '-1 day'), 8, 'blue', 25, 79, 0 FROM meta WHERE key = 'today';
INSERT INTO catch (species_id, game_id, caught_at, level, shiny, method, ball, nickname, trade_id, hunt_id)
  SELECT received_id, game_id, traded_at, 1, 0, 'Trade', NULL, NULL, id, NULL FROM trade WHERE id > (SELECT MAX(id) - 2 FROM trade);
INSERT INTO catch (species_id, game_id, caught_at, level, shiny, method, ball, nickname, trade_id, hunt_id)
  SELECT 32, 'blue', date(value, '-1 day'), 12, 0, 'Wild', 'Poké Ball', NULL, NULL, NULL FROM meta WHERE key = 'today';
