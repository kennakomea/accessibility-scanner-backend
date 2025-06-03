exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createTable('scan_results', {
    id: 'id', // Shorthand for SERIAL PRIMARY KEY
    job_id: { type: 'varchar(255)', unique: true },
    original_job_id: { type: 'varchar(255)' },
    submitted_url: { type: 'text', notNull: true },
    actual_url: { type: 'text' },
    scan_timestamp: {
      type: 'timestamptz',
      default: pgm.func('current_timestamp'),
    },
    page_title: { type: 'text' },
    scan_success: { type: 'boolean', notNull: true },
    violations: { type: 'jsonb' },
    error_message: { type: 'text' },
  });
};

exports.down = (pgm) => {
  pgm.dropTable('scan_results');
};