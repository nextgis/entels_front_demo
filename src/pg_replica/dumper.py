#!/usr/bin/env python
# -*- coding: utf-8 -*-

import os
import subprocess
import datetime
import time
import re
import glob
import shutil
import base64

import logging
import ConfigParser

from bus_communicator import BusCommunicator, BusCommunicatorError


class DumperError(Exception):
    pass

class Dumper():
    def __init__(self, config_name='/etc/pg_replica.conf'):
        """Initialization of Dumper: read the config file, set up internal variables

        :param config_name: The name of the config file
        """

        self.logger = logging.getLogger('dumper')
        self.logger.setLevel(logging.DEBUG)
        formatter = logging.Formatter('%(asctime)s %(name)s: %(levelname)s: %(message)s', datefmt='%b %d %H:%M:%S')

        ch = logging.StreamHandler()
        ch.setLevel(logging.WARN)
        ch.setFormatter(formatter)
        self.logger.addHandler(ch)

        if not os.path.isfile(config_name):
            msg = 'Configuration file "%s" not found.' % config_name
            self.logger.critical(msg)
            raise DumperError(msg)

        config = ConfigParser.ConfigParser()
        config.read(config_name)

        try:
            # Connection info
            self.database = config.get('database', 'database')
            self.host = config.get('database', 'host')
            self.port = config.get('database', 'port')
            self.user = config.get('database', 'user')
            self.password = config.get('database', 'password')
            os.putenv('PGPASSWORD', self.password)

            # Dump options
            self.outdate_interval = config.get('fulldump', 'outdate_interval')  # Hours
            self.outdate_interval = float(self.outdate_interval) * 3600         # Seconds

            self.tables = config.get('fulldump', 'tables_for_dump')
            self.tables = [t.strip() for t in self.tables.split(',')]

            self.max_chapter_size = config.get('fulldump', 'chapter_size')
            self.max_chapter_size = int(self.max_chapter_size)

            # Bus
            self.bus_uri = config.get('bus', 'uri')
            self.bus_user = config.get('bus', 'user')
            self.bus_passwd = config.get('bus', 'password')
            self.bus_addr = config.get('bus', 'address')

            # Paths
            self._set_dump_path(config.get('path', 'dump'))
            self._set_logfile_name(config.get('logging', 'log_file'))
        except ConfigParser.NoSectionError as e:
            msg = 'A section does not found in the ' \
                  'configuration file "%s" not found: %s' % (config_name, e.message)
            self.logger.critical(msg)
            raise
        except ConfigParser.NoOptionError as e:
            msg = 'An option does not found in the ' \
                  'configuration file "%s" not found: %s' % (config_name, e.message)
            self.logger.critical(msg)
            raise

    def ask_for_dump(self, logic_address, table):
        """Initialize process of dump: send message
        """
        sender = BusCommunicator(self.bus_uri,
                                 self.bus_addr,
                                 self.bus_user,
                                 self.bus_passwd)

        action = 'sm://messages/application/gis/geochanges_full_copy'
        request = 'dumpTableRequest'
        addition = '<tbl>%s</tbl>' % table
        sender.send_message(logic_address, request, action, addition_info=addition)

    def dump_table(self, logic_address, tablename):
        """Create dump of the table and send it

        :param tablename: The name of the table
        """

        filename = self._tablename_to_filename(tablename)
        self._create_dumpfile(tablename, filename)
        chapternames = self._split_file(filename)
        chapter_count = len(chapternames)

        action = 'sm://messages/application/gis/geochanges_full_copy'
        request = 'dumpTablePart'
        sender = BusCommunicator(self.bus_uri,
                                 self.bus_addr,
                                 self.bus_user,
                                 self.bus_passwd)

        # Send the dumps and remove the temp files
        for part_number, name in enumerate(chapternames):
            data = '<data>%s</data>' % self._file_to_base64(name)
            total = '<total>%s</total>' % chapter_count
            part_name = '<name>%s</name>' % name
            part = '<part>%s</part>' % part_number
            addition = '\n'.join([data, total, part_name, part])
            sender.send_message(logic_address, request, action, addition_info=addition)
            os.unlink(name)
        os.unlink(filename)

    def get_file_list(self, prefix):
        """Return list of files by their prefix

        :param prefix: The beginning of the file name
        :return: list of the files ordered literally
        """
        pattern = os.path.join(self.dump_path, prefix)
        return sorted(glob.glob(pattern+"*"))

    def get_outdated_tables(self):
        """Create list of tables for dump.
        Find dumpfiles, compare their dates with self.outdate_interval

        :return: list of tablenames
        """
        outdated_files = []
        for tablename in self.tables:
            dumps = self.get_file_list(tablename)
            if not dumps:
                outdated_files.append(tablename)
            else:
                name = dumps[-1]
                if self._is_file_outdated(name):
                    outdated_files.append(tablename)

        return outdated_files

    def restore_table(self, filename):
        """Restore table from dump file

        :param filename: The name of the dumpfile file
        """
        command = self._get_restorer(filename)
        self.logger.debug('Restoring from dump file %s: %s' % (filename, command))

        proc = subprocess.Popen(command, shell=True, stderr=subprocess.PIPE, stdout=subprocess.PIPE)
        (stdoutdata, stderrdata)  = proc.communicate()

        if stderrdata:
            self.logger.error("The command '%s' returns the error: %s" % (command, stderrdata.strip()))
        else:
            self.logger.info('Dump of file %s is restored' % (filename, ))

    def restore(self):
        for tablename in self.tables:
            dumps = self.get_file_list(tablename)
            if not dumps:
                msg = "Can't find dumps of table %s" % (tablename, )
                self.logger.error(msg)
                raise DumperError(msg)
            dumper.restore_table(dumps[-1])     # Restore the last dump

    def join_files(self, prefix, remove_parts=False):
        """Create full dump file from chapters. It's inverse operation to self._split_file method.

        :param prefix: The beginning of the file name
        :param remove_parts: boolean value. It indicates to remove or not the chapters after the joining
        """
        chapter_list = self.get_file_list(prefix+'.part')   # See _split_file
        self.logger.debug('Start joining of files %s into one file %s' % (', '.join(chapter_list), prefix))
        with open(os.path.join(self.dump_path, prefix), 'wb') as destination:
            for chapter in chapter_list:
                shutil.copyfileobj(open(chapter, 'rb'), destination)
        self.logger.info('File %s is created' % prefix)
        if remove_parts:
            for chapter in chapter_list:
                os.unlink(chapter)
                self.logger.debug('Remove file %s', chapter)

    def chapter_name_to_filename(self, chapter_name):
        """Get name of the dumpfile from chapter_name. See _split_file.

        :param chapter_name: name in format filename.part.XXXXXX
        :return: name of the file
        """
        return os.path.basename(chapter_name[:-12])   # filename.part.XXXXXX

    def _split_file(self, filename, buffer_size=4*1024):
        """Split file into pieces (chapters) of given size and store them in files

        :param filename: The name of the file that has to be splitted on chapters
        :param buffer_size: Auxiliary value for size of reading buffer (in bytes)
        :return list of filenames
        """
        self.logger.debug('Splitting file %s into chapters...' % filename)
        suffix='.part'
        chaptername_list = []
        finished = False
        with open(filename, 'rb') as src:
            while True:
                chaptername = filename + suffix + '.%06d' % len(chaptername_list)
                chaptername_list.append(chaptername)
                chapter = open(chaptername, 'wb')

                written = 0

                while written < self.max_chapter_size:
                    byte_count = min(buffer_size, self.max_chapter_size - written)
                    data = src.read(byte_count)
                    chapter.write(data)
                    written += len(data)
                    if len(data) < byte_count:
                        finished = True
                        break
                chapter.close()
                if finished:
                    break
        self.logger.debug('File %s is divided into %s chapters' % (filename, len(chaptername_list)))
        return chaptername_list

    def _analyze_filename(self, filename):
        """Inverse operation to _tablename_to_filename method.
        Returns info about the tablename and date of the creation extracted from the filename.

        :param filename: The name of the file
        :return: dict of the 'tablename', 'time' and their values. If the file name does not
                 match the pattern, return None
        """

        # filename must be smth like: 'TABLENAME_YYYMMDDHHMMSS.fullcopy'
        pattern = r".+_[0-9]{14}\.fullcopy$"
        if not re.match(pattern, filename):
            return None

        dateval = filename[-23:-9]
        date = time.strptime(dateval, '%Y%m%d%H%M%S')
        stump = time.mktime(date)

        result = dict(
            tablename = filename[0:-24],
            time = stump
        )
        return result

    def _create_dumpfile(self, tablename, filename):
        """Dump table into the file

        :param tablename: The name of the table that has to be stored in the file
        :param filename: The name of the file
        :return boolean flag of success
        """

        command = self._get_dumper(tablename, filename)

        self.logger.debug('Dump of "%s.%s" is starting: %s' % (self.database, tablename, command))

        proc = subprocess.Popen(command, shell=True, stderr=subprocess.PIPE, stdout=subprocess.PIPE)
        (stdoutdata, stderrdata)  = proc.communicate()

        if stderrdata:
            self.logger.critical("The command '%s' returns the error: %s" % (command, stderrdata.strip()))
            return False
        else:
            self.logger.info('Dump of "%s.%s" is created' % (self.database, tablename))
            return True

    def base64_to_file(self, data, filename):
        """Decode data from base64 format and save the result

        :param data:     The string in base64 format
        :param filename: The name of the file
        """
        data = base64.b64decode(data)
        with open(filename, 'w') as f:
            f.write(data)

    def _file_to_base64(self, filename):
        """Encode file in base64

        :param filename: The name of the file
        :return string of encoded file
        """
        with open(filename) as f:
            encoded = base64.b64encode(f.read())

        return encoded

    def _get_dumper(self, tablename, filename):
        """Return string representation of dump command. Use pg_dump as the dumping machine.
        see `pg_dump --help` for details of the parameters

        :param tablename: The name of the table that has to be stored or None
        :param filename: The name of the dump file
        :return: string of the dump command
        """
        dumper = """pg_dump  --host=%s --username=%s --dbname=%s --file=%s --clean --blobs --table=%s --format=plain""" % \
                     (self.host, self.user, self.database, filename, tablename)

        return dumper

    def _is_file_outdated(self, filename):
        """Check is dump of a table oudtated or not

        :param filename: The name of the file
        :return: boolean value
        """
        fileinfo = self._analyze_filename(filename)
        if not fileinfo:   # The file is not dump file
            return False
        stump = fileinfo['time']
        current_time = time.time()
        return (current_time - stump > self.outdate_interval)

    def _get_restorer(self, filename):
        """Return string representation of dump restoring command. Use pg_restore.
        see `pg_restore --help` for details of the parameters

        :param filename: The name of the dump file
        :return: string of the dump command
        """
        filename = os.path.join(self.dump_path, filename)
        restorer = """pg_restore --clean --host=%s --port=%s --username=%s --dbname=%s %s """ % \
                   (self.host, self.port, self.user, self.database, filename)
        restorer = """psql "host=%s user=%s dbname=%s" --file=%s""" % \
                   (self.host, self.user, self.database, filename)
        return restorer

    def _tablename_to_filename(self, tablename):
        """Create filename for dump file.
        :param tablename: Name of the table that has to be stored in the file
        :return:  string of filename
        """
        ts = time.time()
        ts = datetime.datetime.fromtimestamp(ts).strftime('%Y%m%d%H%M%S')
        filename = tablename + '_' + ts + '.fullcopy'
        return os.path.join(self.dump_path, filename)

    def _set_dump_path(self, path):
        self.dump_path = path
        # pg_dump cant't create directories, so
        # if the dump directory is not created, create it:
        try:
            os.mkdir(self.dump_path)
        except OSError:
            pass    # the directory exists

    def _set_logfile_name(self, filename):
        self.logfile_name = filename

        # Add logging into the file:
        formatter = logging.Formatter('%(asctime)s %(name)s: %(levelname)s: %(message)s', datefmt='%b %d %H:%M:%S')
        ch = logging.FileHandler(self.logfile_name)
        ch.setLevel(logging.DEBUG)
        ch.setFormatter(formatter)
        self.logger.addHandler(ch)


if __name__ == "__main__":
    try:
        dumper = Dumper(config_name='pg_replica.conf')
        dumps = dumper.dump(split_files=False, remove_original=False)
    except:
        raise

    dumper.restore()

