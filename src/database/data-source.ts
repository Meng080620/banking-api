import 'dotenv/config';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../config/database.config';

/** Used by the TypeORM CLI for migration generate/run/revert. */
export default new DataSource(buildDataSourceOptions());
