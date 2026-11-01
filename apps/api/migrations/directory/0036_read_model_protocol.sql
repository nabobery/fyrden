-- The read model refuses writes outside the executor's admission from org migration 0018 on,
-- whose protocol is 2: no executor of an older protocol takes a lease from now on.
UPDATE read_model_barriers SET protocol_version = 2 WHERE protocol_version < 2;
